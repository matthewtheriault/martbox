import { gunzipSync } from 'zlib'
import { setSetting } from './db'
import { replaceIptvData } from './repository'
import { parseM3u, parseXmltv } from './iptvParser'
import type { IptvRefreshResult } from '../shared/types'

// Public XMLTV EPG URLs are very commonly served as .xml.gz — a
// gzip-compressed *file body*, distinct from HTTP transport
// Content-Encoding: gzip (which fetch already auto-decodes). Sniff the
// gzip magic bytes and decompress if needed, or the parser gets fed
// binary garbage on many real feeds.
async function fetchTextMaybeGzip(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
  return (isGzip ? gunzipSync(buf) : buf).toString('utf8')
}

export async function refreshIptv(
  m3uUrl: string,
  epgUrl: string | null
): Promise<IptvRefreshResult> {
  const m3uText = await fetchTextMaybeGzip(m3uUrl)
  const channels = parseM3u(m3uText)

  let programmes: Awaited<ReturnType<typeof parseXmltv>> = []
  if (epgUrl) {
    const knownIds = new Set(channels.map((c) => c.tvgId).filter((v): v is string => !!v))
    const xmlText = await fetchTextMaybeGzip(epgUrl)
    programmes = await parseXmltv(xmlText, knownIds)
  }

  // Only replace existing data once both fetches/parses have succeeded, so
  // a bad refresh (unreachable URL, malformed feed) never wipes out a
  // previously-working channel list.
  replaceIptvData(channels, programmes)

  const refreshedAt = new Date().toISOString()
  setSetting('iptvLastRefreshedAt', refreshedAt)
  setSetting('iptvLastError', '')
  return { channelCount: channels.length, programmeCount: programmes.length, refreshedAt, error: null }
}
