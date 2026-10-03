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
// While connected, the sidecar also re-emits its status every few seconds
// with a per-peer "path" (direct / relayed / idle) whenever it changes, so
// the app can tell the user whether friends are getting a fast direct
// connection or falling back to Tailscale's shared (slow) DERP relays. Each
// peer carries its tailnet address so the host can match it to a signed-in
// device (dashboard); public IP addresses are never included.
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
	"net/netip"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

// Must match TSNET_FIXED_PORT in src/shared/remoteAccess.ts.
const fixedPort = 47823

type peerMsg struct {
	Hostname string `json:"hostname"`
	Online   bool   `json:"online"`
	// "direct": peer-to-peer UDP path; "relayed": traffic is flowing through
	// a DERP relay; "idle": no recent traffic, so there's no path to report.
	Path        string `json:"path"`
	RelayRegion string `json:"relayRegion,omitempty"`
	// The peer's first tailnet (100.x) address; matching only, never shown.
	Addr string `json:"addr,omitempty"`
}

type statusMsg struct {
	Status        string    `json:"status"`
	TailscaleAddr string    `json:"tailscaleAddr,omitempty"`
	LocalPort     int       `json:"localPort,omitempty"`
	Message       string    `json:"message,omitempty"`
	Peers         []peerMsg `json:"peers,omitempty"`
}

var emitMu sync.Mutex

func emit(m statusMsg) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	emitMu.Lock()
	defer emitMu.Unlock()
	fmt.Println(string(b))
}

const peerPollInterval = 5 * time.Second

// watchPeers re-emits base (the "connected" status) with an updated peer
// list whenever any peer's path changes. onlyIP, if valid, limits the list
// to that one peer (client mode only cares about its host).
func watchPeers(ctx context.Context, srv *tsnet.Server, base statusMsg, onlyIP netip.Addr) {
	lc, err := srv.LocalClient()
	if err != nil {
		return
	}
	var last string
	ticker := time.NewTicker(peerPollInterval)
	defer ticker.Stop()
	for {
		st, err := lc.Status(ctx)
		if err == nil {
			peers := []peerMsg{}
			for _, p := range st.Peer {
				if onlyIP.IsValid() && !containsIP(p.TailscaleIPs, onlyIP) {
					continue
				}
				pm := peerMsg{Hostname: p.HostName, Online: p.Online, Path: "idle"}
				if len(p.TailscaleIPs) > 0 {
					pm.Addr = p.TailscaleIPs[0].String()
				}
				switch {
				case p.CurAddr != "":
					pm.Path = "direct"
				case p.Active && p.Relay != "":
					pm.Path = "relayed"
					pm.RelayRegion = p.Relay
				}
				peers = append(peers, pm)
			}
			sort.Slice(peers, func(i, j int) bool { return peers[i].Hostname < peers[j].Hostname })
			b, _ := json.Marshal(peers)
			if string(b) != last {
				last = string(b)
				m := base
				m.Peers = peers
				emit(m)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func containsIP(ips []netip.Addr, ip netip.Addr) bool {
	for _, a := range ips {
		if a == ip {
			return true
		}
	}
	return false
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

const (
	// A dial to a peer the tailnet hasn't routed yet doesn't fail — the
	// SYN is silently dropped and TCP retransmits with exponential backoff
	// (1s, 2s, 4s, 8s…), so one stuck dial can take tens of seconds. Short
	// attempts with a fresh SYN each time get through as soon as the path is
	// up.
	dialAttemptTimeout = 3 * time.Second
	dialTotalTimeout   = 30 * time.Second
	// How long client mode waits for the host to answer before reporting
	// "connected" anyway (the app then retries on its own).
	hostWarmupTimeout = 20 * time.Second
)

func dialHost(srv *tsnet.Server, hostAddr string) (net.Conn, error) {
	deadline := time.Now().Add(dialTotalTimeout)
	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), dialAttemptTimeout)
		conn, err := srv.Dial(ctx, "tcp", hostAddr)
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
		time.Sleep(200 * time.Millisecond)
	}
	return nil, lastErr
}

// waitForHost blocks until the host answers a disco ping or the timeout
// passes. srv.Up returns once this node is logged in to the control plane,
// which isn't the same as having a path to the host — pinging also starts
// NAT traversal early, so the first real request usually goes direct.
func waitForHost(ctx context.Context, srv *tsnet.Server, hostIP netip.Addr) bool {
	if !hostIP.IsValid() {
		return false
	}
	lc, err := srv.LocalClient()
	if err != nil {
		return false
	}
	deadline := time.Now().Add(hostWarmupTimeout)
	for time.Now().Before(deadline) {
		pctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		res, err := lc.Ping(pctx, hostIP, tailcfg.PingDisco)
		cancel()
		if err == nil && res != nil && res.Err == "" {
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func serveClientForward(ln net.Listener, srv *tsnet.Server, hostAddr string) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			emit(statusMsg{Status: "error", Message: err.Error()})
			continue
		}
		go func(c net.Conn) {
			remote, err := dialHost(srv, hostAddr)
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
	udpPort := flag.Uint("udp-port", 0, "UDP port for WireGuard/peer-to-peer traffic (0 = pick automatically). A fixed port can be forwarded on the router so peers connect directly instead of via relays.")
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
		Port:     uint16(*udpPort),
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
		connected := statusMsg{Status: "connected", TailscaleAddr: tailscaleAddr}
		emit(connected)
		go watchPeers(ctx, srv, connected, netip.Addr{})
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
		var hostIP netip.Addr
		if ap, err := netip.ParseAddrPort(*hostAddr); err == nil {
			hostIP = ap.Addr()
		}
		// Hold "connected" (and the local port the app sends requests to)
		// until the host actually answers, so the app's first request isn't
		// the one that waits out the path coming up.
		waitForHost(ctx, srv, hostIP)
		connected := statusMsg{Status: "connected", TailscaleAddr: tailscaleAddr, LocalPort: localPort}
		emit(connected)
		go watchPeers(ctx, srv, connected, hostIP)
		serveClientForward(ln, srv, *hostAddr)
	}
}
