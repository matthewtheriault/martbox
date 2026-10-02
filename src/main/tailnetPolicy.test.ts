import { describe, expect, it } from 'vitest'
import { checkPolicy, recommendedPolicy, type TailnetPolicy } from './tailnetPolicy'

const DEFAULT_POLICY: TailnetPolicy = {
  grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }],
  ssh: [{ action: 'check', src: ['autogroup:member'], dst: ['autogroup:self'], users: ['autogroup:nonroot'] }],
  tagOwners: { 'tag:martbox-host': ['autogroup:admin'], 'tag:martbox-guest': ['autogroup:admin'] }
}

const LOCKED_DOWN: TailnetPolicy = {
  grants: [
    { src: ['autogroup:member'], dst: ['autogroup:self'], ip: ['*'] },
    { src: ['autogroup:member'], dst: ['tag:martbox-host'], ip: ['*'] },
    { src: ['tag:martbox-guest'], dst: ['tag:martbox-host'], ip: ['tcp:47823'] }
  ],
  tagOwners: { 'tag:martbox-host': ['autogroup:admin'], 'tag:martbox-guest': ['autogroup:admin'] }
}

describe('checkPolicy', () => {
  it('flags the default allow-all policy', () => {
    const check = checkPolicy(DEFAULT_POLICY)
    expect(check.allowAll).toBe(true)
    expect(check.guestGrant).toBe(false)
    expect(check.lockedDown).toBe(false)
  })

  it('flags a legacy acls allow-all rule', () => {
    const check = checkPolicy({ acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] })
    expect(check.allowAll).toBe(true)
  })

  it('accepts the locked-down policy', () => {
    expect(checkPolicy(LOCKED_DOWN)).toEqual({
      allowAll: false,
      guestGrant: true,
      tagOwners: true,
      extraGuestRules: 0,
      lockedDown: true
    })
  })

  it('counts other rules that reach friends devices', () => {
    const policy = structuredClone(LOCKED_DOWN)
    policy.grants!.push({ src: ['tag:martbox-guest'], dst: ['autogroup:member'], ip: ['*'] })
    policy.acls = [{ action: 'accept', src: ['autogroup:tagged'], dst: ['*:22'] }]
    const check = checkPolicy(policy)
    expect(check.extraGuestRules).toBe(2)
    expect(check.lockedDown).toBe(false)
  })

  it('does not count a broader grant to the host as the MartBox grant', () => {
    const policy = structuredClone(LOCKED_DOWN)
    policy.grants![2] = { src: ['tag:martbox-guest'], dst: ['tag:martbox-host'], ip: ['*'] }
    const check = checkPolicy(policy)
    expect(check.guestGrant).toBe(false)
    expect(check.extraGuestRules).toBe(1)
  })
})

describe('recommendedPolicy', () => {
  it('locks down the default policy and keeps unrelated sections', () => {
    const next = recommendedPolicy(DEFAULT_POLICY)
    expect(checkPolicy(next).lockedDown).toBe(true)
    expect(next.ssh).toEqual(DEFAULT_POLICY.ssh)
    expect(next.tests?.[0].src).toBe('tag:martbox-guest')
    expect(next.tests?.[0].deny).toContain('tag:martbox-host:3389')
  })

  it('does not modify the input', () => {
    const input = structuredClone(DEFAULT_POLICY)
    recommendedPolicy(input)
    expect(input).toEqual(DEFAULT_POLICY)
  })

  it('is idempotent', () => {
    const once = recommendedPolicy(DEFAULT_POLICY)
    expect(recommendedPolicy(once)).toEqual(once)
  })

  it('adds missing tag owners and keeps existing ones', () => {
    const next = recommendedPolicy({ tagOwners: { 'tag:martbox-host': ['someone@example.com'] } })
    expect(next.tagOwners).toEqual({
      'tag:martbox-host': ['someone@example.com'],
      'tag:martbox-guest': ['autogroup:admin']
    })
  })

  it('keeps other rules, including ones it reports', () => {
    const policy = structuredClone(DEFAULT_POLICY)
    policy.grants!.push({ src: ['group:family'], dst: ['tag:nas'], ip: ['tcp:445'] })
    const next = recommendedPolicy(policy)
    expect(next.grants).toContainEqual({ src: ['group:family'], dst: ['tag:nas'], ip: ['tcp:445'] })
  })

  it('drops a legacy allow-all acl and the empty acls list', () => {
    const next = recommendedPolicy({ acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] })
    expect(next.acls).toBeUndefined()
    expect(checkPolicy(next).lockedDown).toBe(true)
  })
})
