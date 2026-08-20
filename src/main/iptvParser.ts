import * as sax from 'sax'

export interface ParsedIptvChannel {
  tvgId: string | null
  name: string
  logoUrl: string | null
  groupTitle: string | null
  streamUrl: string
}

export interface ParsedProgramme {
  channelTvgId: string
  title: string
  description: string | null
  startAt: string
  stopAt: string
}

// Extended M3U for IPTV: an #EXTINF line with key="value" attributes and a
// trailing ",Display Name", followed by a URL line. Other #-prefixed lines
// (#EXTVLCOPT, #KODIPROP, #EXTGRP, #EXTM3U, ...) are directives, not URLs.
export function parseM3u(text: string): ParsedIptvChannel[] {
  const lines = text.split(/\r?\n/)
  const channels: ParsedIptvChannel[] = []
  let pending: Omit<ParsedIptvChannel, 'streamUrl'> | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#EXTINF:')) {
      const attrs: Record<string, string> = {}
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) {
        attrs[m[1].toLowerCase()] = m[2]
      }
      const name = line.slice(line.lastIndexOf(',') + 1).trim()
      pending = {
        tvgId: attrs['tvg-id'] || null,
        name: name || attrs['tvg-name'] || 'Unnamed Channel',
        logoUrl: attrs['tvg-logo'] || null,
        groupTitle: attrs['group-title'] || null
      }
    } else if (line.startsWith('#')) {
      continue
    } else if (pending) {
      channels.push({ ...pending, streamUrl: line })
      pending = null
    }
  }

  return channels
}

// XMLTV's "YYYYMMDDHHmmss [+-ZZZZ]" format -> ISO 8601 UTC.
export function parseXmltvTime(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/.exec(value.trim())
  if (!m) return null
  const [, Y, Mo, D, H, Mi, S, off] = m
  let ms = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S)
  if (off) {
    const sign = off[0] === '-' ? -1 : 1
    const offMinutes = (+off.slice(1, 3) * 60 + +off.slice(3, 5)) * sign
    ms -= offMinutes * 60_000
  }
  return new Date(ms).toISOString()
}

interface InProgressProgramme {
  channel: string
  start: string | null
  stop: string | null
  title: string
  desc: string
  inTitle: boolean
  inDesc: boolean
  sawTitle: boolean
}

// Streaming SAX parse rather than a DOM parser: real XMLTV feeds can run
// tens of MB, and this lets us discard/filter programmes by channel id as
// we go instead of building a full tree first. Only channels present in
// `knownChannelIds` (the M3U's tvg-ids) are kept.
export function parseXmltv(xml: string, knownChannelIds: Set<string>): Promise<ParsedProgramme[]> {
  return new Promise((resolveParse, reject) => {
    const parser = sax.parser(false, { lowercase: true, trim: true })
    const programmes: ParsedProgramme[] = []
    let current: InProgressProgramme | null = null

    parser.onopentag = (node) => {
      if (node.name === 'programme') {
        const channel = String(node.attributes.channel || '')
        if (!channel || !knownChannelIds.has(channel)) {
          current = null
          return
        }
        current = {
          channel,
          start: parseXmltvTime(String(node.attributes.start || '')),
          stop: parseXmltvTime(String(node.attributes.stop || '')),
          title: '',
          desc: '',
          inTitle: false,
          inDesc: false,
          sawTitle: false
        }
      } else if (current && node.name === 'title' && !current.sawTitle) {
        current.inTitle = true
      } else if (current && node.name === 'desc') {
        current.inDesc = true
      }
    }

    parser.ontext = (text) => {
      if (!current) return
      if (current.inTitle) current.title += text
      if (current.inDesc) current.desc += text
    }

    parser.onclosetag = (name) => {
      if (!current) return
      if (name === 'title') {
        current.inTitle = false
        current.sawTitle = true
      }
      if (name === 'desc') current.inDesc = false
      if (name === 'programme') {
        if (current.start && current.stop && current.title) {
          programmes.push({
            channelTvgId: current.channel,
            title: current.title,
            description: current.desc || null,
            startAt: current.start,
            stopAt: current.stop
          })
        }
        current = null
      }
    }

    parser.onerror = (err) => reject(err)
    parser.onend = () => resolveParse(programmes)
    parser.write(xml).close()
  })
}
