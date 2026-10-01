// martbox-sidecar joins a Tailscale tailnet in-process (via tsnet) and forwards
// TCP traffic between the local MartBox Express server and the tailnet, so
// friends can reach it without any port forwarding or a separately-run
// Tailscale client. Two modes:
//
//   host:   accepts connections arriving over the tailnet on the fixed
//           MartBox port and forwards them to the local Express server.
//   client: accepts local loopback connections and forwards them over the
//           tailnet to a host's fixed MartBox port.
//
// The pre-auth key (needed only on first run) is read from stdin, never argv,
// so it doesn't show up in a process listing. After the first successful
// join, tsnet persists node identity under --state-dir and no longer needs
// the key.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"

	"tailscale.com/tsnet"
)

// Must match TSNET_FIXED_PORT in src/shared/remoteAccess.ts.
const fixedPort = 47823

type statusMsg struct {
	Status        string `json:"status"`
	TailscaleAddr string `json:"tailscaleAddr,omitempty"`
	LocalPort     int    `json:"localPort,omitempty"`
	Message       string `json:"message,omitempty"`
}

func emit(m statusMsg) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	fmt.Println(string(b))
}

func readAuthKeyFromStdin() string {
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	return strings.TrimSpace(line)
}

func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(a, b) //nolint:errcheck
		done <- struct{}{}
	}()
	go func() {
		io.Copy(b, a) //nolint:errcheck
		done <- struct{}{}
	}()
	<-done
	a.Close()
	b.Close()
}

func serveHostForward(ln net.Listener, forwardTo string) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			emit(statusMsg{Status: "error", Message: err.Error()})
			continue
		}
		go func(c net.Conn) {
			local, err := net.Dial("tcp", forwardTo)
			if err != nil {
				c.Close()
				return
			}
			pipe(c, local)
		}(conn)
	}
}

func serveClientForward(ln net.Listener, srv *tsnet.Server, hostAddr string) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			emit(statusMsg{Status: "error", Message: err.Error()})
			continue
		}
		go func(c net.Conn) {
			remote, err := srv.Dial(context.Background(), "tcp", hostAddr)
			if err != nil {
				c.Close()
				return
			}
			pipe(c, remote)
		}(conn)
	}
}

func main() {
	mode := flag.String("mode", "", "host or client")
	forwardTo := flag.String("forward-to", "", "host mode: local address to forward tailnet connections to, e.g. 127.0.0.1:12345")
	hostAddr := flag.String("host", "", "client mode: host tailnet address:port to connect to")
	stateDir := flag.String("state-dir", "", "directory to persist tsnet node state")
	hostname := flag.String("hostname", "martbox", "tsnet hostname")
	flag.Parse()

	if *stateDir == "" {
		log.Fatal("--state-dir is required")
	}
	if *mode != "host" && *mode != "client" {
		log.Fatal("--mode must be host or client")
	}

	emit(statusMsg{Status: "starting"})

	srv := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
	}
	if authKey := readAuthKeyFromStdin(); authKey != "" {
		srv.AuthKey = authKey
	}
	defer srv.Close()

	ctx := context.Background()
	status, err := srv.Up(ctx)
	if err != nil {
		emit(statusMsg{Status: "error", Message: err.Error()})
		os.Exit(1)
	}

	tailscaleAddr := ""
	if len(status.TailscaleIPs) > 0 {
		tailscaleAddr = status.TailscaleIPs[0].String()
	}

	switch *mode {
	case "host":
		if *forwardTo == "" {
			log.Fatal("--forward-to is required in host mode")
		}
		ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", fixedPort))
		if err != nil {
			emit(statusMsg{Status: "error", Message: err.Error()})
			os.Exit(1)
		}
		emit(statusMsg{Status: "connected", TailscaleAddr: tailscaleAddr})
		serveHostForward(ln, *forwardTo)
	case "client":
		if *hostAddr == "" {
			log.Fatal("--host is required in client mode")
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			emit(statusMsg{Status: "error", Message: err.Error()})
			os.Exit(1)
		}
		localPort := ln.Addr().(*net.TCPAddr).Port
		emit(statusMsg{Status: "connected", TailscaleAddr: tailscaleAddr, LocalPort: localPort})
		serveClientForward(ln, srv, *hostAddr)
	}
}
