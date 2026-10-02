import { TSNET_FIXED_PORT } from '../shared/remoteAccess'
import type { TailnetPolicyCheck } from '../shared/remoteAccess'

// Checks and fixes the tailnet policy file so friends' devices
// (tag:martbox-guest) can reach only the MartBox port on the host
// (tag:martbox-host). Pure functions over the policy as parsed JSON — the
// API calls live in tailscaleApi.ts.

export const HOST_TAG = 'tag:martbox-host'
export const GUEST_TAG = 'tag:martbox-guest'
const MARTBOX_PORT = `tcp:${TSNET_FIXED_PORT}`

interface Grant {
  src: string[]
  dst: string[]
  ip?: string[]
  [key: string]: unknown
}

interface LegacyAcl {
  action: string
  src: string[]
  dst: string[]
  [key: string]: unknown
}

interface PolicyTest {
  src: string
  accept?: string[]
  deny?: string[]
  [key: string]: unknown
}

export interface TailnetPolicy {
  grants?: Grant[]
  acls?: LegacyAcl[]
  tagOwners?: Record<string, string[]>
  tests?: PolicyTest[]
  [key: string]: unknown
}

const has = (list: string[] | undefined, value: string): boolean => !!list?.includes(value)

// Selectors that match a friend's (tagged guest) device.
const coversGuests = (src: string[] | undefined): boolean =>
  has(src, '*') || has(src, GUEST_TAG) || has(src, 'autogroup:tagged')

function isAllowAllGrant(g: Grant): boolean {
  return has(g.src, '*') && has(g.dst, '*') && (g.ip === undefined || has(g.ip, '*'))
}

function isAllowAllAcl(a: LegacyAcl): boolean {
  return a.action === 'accept' && has(a.src, '*') && has(a.dst, '*:*')
}

function isMartBoxGuestGrant(g: Grant): boolean {
  return (
    g.src.length === 1 &&
    g.src[0] === GUEST_TAG &&
    g.dst.length === 1 &&
    g.dst[0] === HOST_TAG &&
    (g.ip ?? []).length === 1 &&
    g.ip![0] === MARTBOX_PORT
  )
}

// What the owner's own (logged-in) devices keep once allow-all is gone:
// each other, and the MartBox host.
const MEMBER_GRANTS: Grant[] = [
  { src: ['autogroup:member'], dst: ['autogroup:self'], ip: ['*'] },
  { src: ['autogroup:member'], dst: [HOST_TAG], ip: ['*'] }
]
const GUEST_GRANT: Grant = { src: [GUEST_TAG], dst: [HOST_TAG], ip: [MARTBOX_PORT] }

// Makes Tailscale itself refuse a later edit that reopens SSH, Remote
// Desktop or file sharing on the host to friends' devices.
const GUEST_TEST: PolicyTest = {
  src: GUEST_TAG,
  accept: [`${HOST_TAG}:${TSNET_FIXED_PORT}`],
  deny: [`${HOST_TAG}:22`, `${HOST_TAG}:3389`, `${HOST_TAG}:445`]
}

export function checkPolicy(policy: TailnetPolicy): TailnetPolicyCheck {
  const grants = policy.grants ?? []
  const acls = policy.acls ?? []
  const allowAll = grants.some(isAllowAllGrant) || acls.some(isAllowAllAcl)
  const guestGrant = grants.some(isMartBoxGuestGrant)
  const tagOwners = !!policy.tagOwners?.[HOST_TAG] && !!policy.tagOwners?.[GUEST_TAG]
  // Any other rule that lets friends' devices reach something.
  const extraGuestRules =
    grants.filter((g) => !isAllowAllGrant(g) && !isMartBoxGuestGrant(g) && coversGuests(g.src))
      .length + acls.filter((a) => !isAllowAllAcl(a) && coversGuests(a.src)).length
  return {
    allowAll,
    guestGrant,
    tagOwners,
    extraGuestRules,
    lockedDown: !allowAll && guestGrant && tagOwners && extraGuestRules === 0
  }
}

// Removes allow-all rules, adds the MartBox rules (owner's devices keep
// reaching each other and the host), and makes sure the tags have owners.
// Every other rule is kept as it was — extra rules that reach friends'
// devices are reported by checkPolicy, never deleted silently.
export function recommendedPolicy(policy: TailnetPolicy): TailnetPolicy {
  const next: TailnetPolicy = structuredClone(policy)
  const grants = (next.grants ?? []).filter((g) => !isAllowAllGrant(g))
  for (const wanted of [...MEMBER_GRANTS, GUEST_GRANT]) {
    const present = grants.some(
      (g) =>
        JSON.stringify(g.src) === JSON.stringify(wanted.src) &&
        JSON.stringify(g.dst) === JSON.stringify(wanted.dst) &&
        JSON.stringify(g.ip) === JSON.stringify(wanted.ip)
    )
    if (!present) grants.push(structuredClone(wanted))
  }
  next.grants = grants
  if (next.acls) {
    next.acls = next.acls.filter((a) => !isAllowAllAcl(a))
    if (next.acls.length === 0) delete next.acls
  }
  next.tagOwners = {
    ...next.tagOwners,
    [HOST_TAG]: next.tagOwners?.[HOST_TAG] ?? ['autogroup:admin'],
    [GUEST_TAG]: next.tagOwners?.[GUEST_TAG] ?? ['autogroup:admin']
  }
  const tests = next.tests ?? []
  if (!tests.some((t) => t.src === GUEST_TAG)) tests.push(structuredClone(GUEST_TEST))
  next.tests = tests
  return next
}
