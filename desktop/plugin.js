import * as sdk from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

const { COMPOSER_AREAS, gatewayActivationEpoch, host, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } = sdk
const MAX_DURATION_SECONDS = 86400
const DEFAULT_POLL_INTERVAL_MS = 800
const FILE_LIMIT_DEFAULTS = {
  readLimitKiB: 96,
  reviewedWriteLimitKiB: 64,
  sessionWriteLimitKiB: 128,
}
const fileLimits = settings => Object.fromEntries(Object.keys(FILE_LIMIT_DEFAULTS).map(key => [key, settings[key]]))
const SHARE_DEFAULTS = {
  durationSeconds: 0,
  heartbeatSeconds: 8,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  retries: 3,
  ...FILE_LIMIT_DEFAULTS,
}
const MIN_POLL_INTERVAL_MS = 250
const BRIDGE_TIMEOUT_MS = 4000
const RETRY_DELAY_MS = 250
// Reserve time for the request and a retry where the heartbeat permits. Always allow the default interval.
const maxPollInterval = heartbeatSeconds => Math.min(5000,
  Math.max(DEFAULT_POLL_INTERVAL_MS, heartbeatSeconds * 1000 - BRIDGE_TIMEOUT_MS - 2 * RETRY_DELAY_MS))
const REVIEW_DISPLAY_LIMIT = 144 * 1024
const ENTRY_LIMIT = 100
const SAVE_LIMIT = 16
const ROUTE = '/drawbridge'
const CHAT_ROUTE = '/drawbridge/share'
const encoder = new TextEncoder()
const permissionsFor = ({ allowUpdate, allowCreate }) => [
  'read', ...(allowUpdate ? ['update'] : []), ...(allowCreate ? ['create'] : []),
]
const outcomeKey = ({ connection, profile, sessionId }) => JSON.stringify([connection, profile, sessionId])
const validInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
const accessLabel = ({ allowUpdate, allowCreate }) =>
  allowUpdate || allowCreate ? permissionsFor({ allowUpdate, allowCreate }).map(
    permission => permission[0].toUpperCase() + permission.slice(1),
  ).join(', ') : 'Read-only'

const errors = {
  'already-sharing': 'This chat already has a shared folder. Stop that share before starting another.',
  busy: 'This profile has too many active folder shares. Stop a share and try again.',
  identity: 'Desktop could not verify the chat. Focus the chat and open Drawbridge again.',
  'share-ended': 'The share expired. Start sharing again to reconnect.',
  'not-granted': 'Desktop revoked access to this folder.',
  'folder-missing': 'The shared folder is no longer available.',
  'folder-changed': 'The folder changed. Choose it again before sharing.',
  'request-ended': 'The access request expired. Review the permissions and start a new grant.',
  'invalid-size-settings': 'The VPS file size limits must be positive whole numbers. Check the Drawbridge plugin settings for this profile.',
  'connection': 'Sharing stopped because the gateway could not be reached. Check that the VPS plugin is enabled.',
  'connection-lost': 'Sharing stopped because the connection did not recover. Start a new share to reconnect.',
  'route-changed': 'Sharing stopped when the gateway or profile changed.',
}

function failure(error) {
  return { ok: false, error }
}

function errorMessage(error) {
  return Object.hasOwn(errors, error) ? errors[error] : errors.connection
}

function validPath(path, op) {
  if (typeof path !== 'string' || !path || path.length > 512) return false
  if (path === '.') return op === 'list'
  return !/[\\:<>"|?*\u0000-\u001f\u007f]/u.test(path) && path.split('/').every(part =>
    part.length > 0 && part.length <= 255 && part === part.trim() && !part.endsWith('.') &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(part.split('.')[0].trimEnd()),
  )
}

async function perform(files, share, args) {
  if (!args || typeof args !== 'object' || Object.keys(args).length !== 2 ||
      !Object.hasOwn(args, 'op') || !Object.hasOwn(args, 'path')) return failure('invalid-request')
  const { op, path } = args
  if (!['list', 'read'].includes(op) || !validPath(path, op)) return failure('invalid-request')
  const id = share.folder.id
  if (op === 'list') {
    const result = await files.list(id, path)
    if (!result.ok) return failure(result.error)
    return {
      ok: true,
      entries: result.entries.slice(0, ENTRY_LIMIT).map(({ name, isDirectory }) => ({ name, isDirectory })),
      truncated: Boolean(result.truncated || result.entries.length > ENTRY_LIMIT),
    }
  }
  const result = await readText(files, share, path, share.readLimitKiB * 1024)
  if (!result.ok) return failure(result.error)
  if (share.allowUpdate &&
      encoder.encode(result.text).length <= Math.max(share.reviewedWriteLimitKiB, share.sessionWriteLimitKiB) * 1024) {
    return { ok: true, text: result.text, baseVersion: await version(share, path, result.text) }
  }
  return { ok: true, text: result.text }
}

function textError(text, limit) {
  if (typeof text !== 'string' || /[\u0000\uD800-\uDFFF]/u.test(text)) return 'invalid-text'
  if (text.length > limit || encoder.encode(text).length > limit) return 'too-large'
}

async function readText(files, share, path, limit) {
  const result = await files.readText(share.folder.id, path)
  if (!result.ok) return failure(result.error)
  const error = share.allowUpdate
    ? textError(result.text, limit) ?? (result.text.includes('\uFFFD') && 'invalid-text')
    : encoder.encode(result.text).length > limit && 'too-large'
  return error ? failure(error) : result
}

async function version(share, path, text) {
  const bytes = encoder.encode(JSON.stringify([share.token, path, text]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function displayText(text) {
  return JSON.stringify(text).replace(/[\p{C}\p{M}\p{Z}\p{Default_Ignorable_Code_Point}]/gu, character =>
    character === ' ' ? character : '\\u{' + character.codePointAt(0).toString(16) + '}',
  )
}

function folderBreadcrumbs(path) {
  const windows = /^(?:[A-Za-z]:|\\\\)/u.test(path)
  const parts = path.split(windows ? /[\\/]+/u : /\/+/u).filter(Boolean)
  if (!windows && path.startsWith('/')) parts.unshift('/')
  if (path.startsWith('\\\\') && parts.length) parts[0] = '\\\\' + parts[0]
  return h('ol', { className: 'flex flex-wrap items-baseline gap-x-2 gap-y-1', 'aria-label': 'Folder path' },
    ...parts.map((part, index) => h('li', { key: index, className: 'flex min-w-0 items-baseline gap-2' },
      index > 0 && h('span', { className: 'text-(--ui-text-tertiary)', 'aria-hidden': true }, '›'),
      h('span', { className: 'break-all ' + (index === parts.length - 1 ? 'font-medium' : 'text-(--ui-text-secondary)') },
        part.replace(/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
          character => '\\u{' + character.codePointAt(0).toString(16) + '}')),
    )))
}

function diffText(text, sign) {
  return text.split(/(?<=\n)/u).map(line => sign + ' ' + displayText(line)).join('\n')
}

function proposalDiff({ text, base, updating }) {
  return (updating ? diffText(base, '-') + '\n' : '') + diffText(text, '+')
}

async function prepare(files, share, job) {
  const { args } = job
  const { op, path, text, baseVersion } = args
  const updating = op === 'propose_update'
  const fields = updating ? ['op', 'path', 'text', 'baseVersion'] : ['op', 'path', 'text']
  if (Object.keys(args).length !== fields.length || !fields.every(field => Object.hasOwn(args, field)) ||
      !validPath(path, op) || (updating && (typeof baseVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(baseVersion)))) {
    return { result: failure('invalid-request') }
  }
  if (updating ? !share.allowUpdate : !share.allowCreate) return { result: failure('permission-denied') }
  const sessionApproved = job.nativeReview === true && job.sessionApproved === true
  const writeLimit = (sessionApproved ? share.sessionWriteLimitKiB : share.reviewedWriteLimitKiB) * 1024
  const error = textError(text, writeLimit)
  if (error) return { result: failure(error) }
  let base
  if (updating) {
    const read = await readText(files, share, path, writeLimit)
    if (!read.ok) return { result: failure(read.error === 'not-found' ? 'conflict' : read.error) }
    base = read.text
    if (await version(share, path, base) !== baseVersion) return { result: failure('conflict') }
  }
  if (share.proposals.size >= 8) return { result: failure('busy') }
  const proposal = Object.freeze({ id: job.id, path, text, base, updating, writeLimit, nativeReview: job.nativeReview === true })
  const result = { ok: true, proposalId: job.id, status: 'pending' }
  if (proposal.nativeReview && !sessionApproved) {
    result.display = (updating ? 'Update ' : 'Create ') + displayText(path) +
      ' in ' + displayText(share.folderName) + '\n\n' +
      proposalDiff(proposal) + '\n\nClick Run to approve this edit only.' +
      '\nFor later edits too, choose Allow this session from the approval options. This approves the edit immediately ' +
      'and allows later writes up to ' + share.sessionWriteLimitKiB +
      ' KiB within this folder’s share and permissions in this chat.' +
      '\nClick Reject to leave the file unchanged. Drawbridge does not support permanent approval.'
    if (encoder.encode(result.display).length > REVIEW_DISPLAY_LIMIT) return { result: failure('review-too-large') }
  }
  return { result, proposal }
}

export default {
  id: 'hermes-drawbridge',
  name: 'Drawbridge',
  defaultEnabled: false,

  register(ctx) {
    const supported = typeof gatewayActivationEpoch === 'function' && COMPOSER_AREAS?.microActions &&
      host.state.focusedSessionId && host.state.focusedStoredSessionId && host.state.focusedSessionOwner &&
      host.state.connectionId && typeof host.activeConnectionId === 'function' && typeof ctx.rest === 'function' &&
      typeof host.request === 'function' && ctx.files?.requestFolder &&
      ctx.files?.folders && ctx.files?.list && ctx.files?.readText
    const listeners = new Set()
    const shares = new Map()
    const outcomes = new Map()
    const requestCache = new Map()
    const readSetting = (key, fallback, min, max) => {
      const value = ctx.storage.get(key, fallback)
      return validInteger(value, min, max) ? value : fallback
    }
    function connectionSettings() {
      const heartbeatSeconds = readSetting('heartbeatSeconds', SHARE_DEFAULTS.heartbeatSeconds, 5, 120)
      return {
        heartbeatSeconds,
        pollIntervalMs: readSetting('pollIntervalMs', SHARE_DEFAULTS.pollIntervalMs,
          MIN_POLL_INTERVAL_MS, maxPollInterval(heartbeatSeconds)),
        retries: readSetting('retries', SHARE_DEFAULTS.retries, 0, 10),
        ...Object.fromEntries(Object.entries(FILE_LIMIT_DEFAULTS).map(([key, ceiling]) =>
          [key, readSetting(key, ceiling, 1, ceiling)])),
      }
    }
    const shareDefaults = () => ({
      durationSeconds: readSetting('durationSeconds', SHARE_DEFAULTS.durationSeconds, 0, MAX_DURATION_SECONDS),
      ...connectionSettings(),
    })
    let view = {
      selection: null, folder: null,
      ...shareDefaults(), allowUpdate: false, allowCreate: false,
      picking: false, changing: false, accessRequest: null, message: '', activity: '',
    }
    let revision = 0
    let opening
    let openSequence = 0
    let disposed = false
    let saveQueue = Promise.resolve()
    let queuedSaves = 0

    function update(changes) {
      view = { ...view, ...changes }
      revision++
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function routeMatches(current) {
      return host.state.profile.get() === current.profile &&
        host.activeConnectionId() === current.connection &&
        gatewayActivationEpoch() === current.epoch
    }

    const sameRoute = current => routeMatches(current) && host.state.gateway.get() === 'open'
    const selected = current => view.selection && outcomeKey(view.selection) === outcomeKey(current)
    const sharesFor = selection => [...shares.values()].filter(share => outcomeKey(share) === outcomeKey(selection))

    function folderName(folder, selection) {
      const leaf = folder.path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''
      const cleaned = leaf.replace(/[\p{C}\p{Z}]/gu, ' ').trim()
      const base = [...cleaned].slice(0, 56).join('').trimEnd() || 'Shared folder'
      const used = new Set(sharesFor(selection).map(share => share.folderName.toLowerCase()))
      let name = base
      for (let number = 2; used.has(name.toLowerCase()); number++) name = base + ' (' + number + ')'
      return name
    }

    function stillFocused(current) {
      const owner = host.state.focusedSessionOwner.get()
      return sameRoute(current) && owner?.profile === current.profile && owner.connectionId === current.connection &&
        host.state.focusedSessionId.get() === current.runtimeId &&
        host.state.focusedStoredSessionId.get() === current.sessionId
    }

    async function resolveSession(current) {
      if (!sameRoute(current)) return null
      const response = await host.request('session.active_list', { profile: current.profile }, BRIDGE_TIMEOUT_MS)
      const matches = Array.isArray(response?.sessions)
        ? response.sessions.filter(row => row?.id === current.runtimeId || row?.session_key === current.sessionId)
        : []
      const [row] = matches
      return matches.length === 1 && row.id === current.runtimeId && row.session_key === current.sessionId ? row : null
    }

    function request(current, action, body = {}) {
      const options = {
        method: 'POST',
        timeoutMs: BRIDGE_TIMEOUT_MS,
        body: { ...body, action, ...(current.token ? { token: current.token } : {}) },
      }
      if (!sameRoute(current)) return Promise.reject(new Error(errors['route-changed']))
      // TODO: Bind each share to its original profile when public route-aware ctx.rest ships.
      return ctx.rest('/chat-bridge', options)
    }

    function stop(current, message = 'Sharing stopped.', notifyBroker = true) {
      if (shares.get(current.token) !== current) return
      shares.delete(current.token)
      current.cancelPoll?.()
      current.proposals.clear()
      if (!['Sharing stopped.', 'Folder access upgraded.', 'Choose permissions and start a new grant.'].includes(message)) {
        const activeConnection = host.state.connectionId.get()
        const gateway = !activeConnection ? 'unavailable' : activeConnection === current.connection ? 'same' : 'different'
        const profile = host.state.profile.get() === current.profile ? 'same' : 'different'
        // Hermes persists error-level renderer messages to its Desktop log.
        console.error('[Drawbridge] Share ended (gateway=' + gateway +
          ', profile=' + profile + '): ' + message)
      }
      update(selected(current) ? { message } : {})
      if (notifyBroker && sameRoute(current)) return request(current, 'stop').catch(() => {})
    }

    function isLive(current) {
      if (shares.get(current.token) !== current) return false
      if (!sameRoute(current)) {
        stop(current, errors['route-changed'])
        return false
      }
      if (performance.now() >= current.expiresAt) {
        stop(current, 'This chat’s folder grant expired.')
        return false
      }
      return true
    }

    function jobStillLive(current, deadline) {
      if (!isLive(current)) return false
      if (performance.now() >= deadline) {
        if (selected(current)) update({ activity: 'The file request expired. The share is still active.' })
        schedulePoll(current)
        return false
      }
      return true
    }

    function schedulePoll(current, delay = current.pollIntervalMs) {
      current.cancelPoll = ctx.setTimeout(() => void poll(current), delay)
    }

    async function checkJob(current, deadline) {
      if (!jobStillLive(current, deadline)) return false
      const row = await resolveSession(current)
      if (!jobStillLive(current, deadline)) return false
      if (!row) {
        stop(current, errors.identity)
        return false
      }
      return true
    }

    async function poll(current) {
      if (!isLive(current)) return
      let bridgeRequest = false
      try {
        const grants = await ctx.files.folders()
        if (!isLive(current)) return
        if (!grants.some(grant => grant.id === current.folder.id)) return stop(current, errors['not-granted'])
        const sentAt = performance.now()
        bridgeRequest = true
        const reply = await request(current, 'poll')
        bridgeRequest = false
        if (!isLive(current)) return
        if (reply?.ok !== true) return stop(current, errorMessage(reply?.error))
        current.lastContact = sentAt
        current.retriesUsed = 0
        if (reply.approval) {
          const { id, decision } = reply.approval
          const item = current.proposals.get(id)
          if (item?.proposal.nativeReview && (decision === 'once' || decision === 'rejected')) {
            void review(current, () => !disposed && isLive(current), item, decision === 'once')
          }
        }
        const job = reply.job
        if (job) {
          if (job.sessionId !== current.sessionId || typeof job.id !== 'string' ||
              !Number.isFinite(job.ttlMs) || job.ttlMs <= 0) {
            return stop(current, 'The gateway sent an invalid chat request.')
          }
          const deadline = sentAt + Math.min(job.ttlMs, 7000)
          if (!await checkJob(current, deadline) || !jobStillLive(current, deadline)) return
          let result, proposal
          try {
            if (['propose_update', 'propose_create'].includes(job.args?.op)) {
              ({ result, proposal } = await prepare(ctx.files, current, job))
            } else {
              result = await perform(ctx.files, current, job.args)
            }
          } catch {
            result = failure('io-error')
          }
          if (!await checkJob(current, deadline) || !jobStillLive(current, deadline)) return
          const remainingGrants = await ctx.files.folders()
          if (!jobStillLive(current, deadline)) return
          if (!remainingGrants.some(grant => grant.id === current.folder.id)) return stop(current, errors['not-granted'])
          bridgeRequest = true
          const receipt = await request(current, 'finish', { id: job.id, result })
          bridgeRequest = false
          if (!isLive(current)) return
          if (receipt?.error === 'request-ended' || (proposal && receipt?.error === 'busy')) {
            if (selected(current)) {
              update({ activity: receipt.error === 'busy' ? 'The review queue is full.' : 'The file request ended. The share is still active.' })
            }
            schedulePoll(current)
            return
          }
          if (receipt?.ok !== true) return stop(current, 'The gateway did not confirm the result.')
          if (receipt.resultError === 'result-too-large') {
            proposal = undefined
            result = failure(receipt.resultError)
          }
          if (proposal) current.proposals.set(proposal.id, { proposal, pending: true })
          const { op, path } = job.args ?? {}
          if (selected(current)) {
            update({ activity: (validPath(path, op) ? displayText(path) : 'File request') + ' · ' +
              (result.status === 'pending' ? 'Ready for review' : result.ok ? 'Done' : result.error) })
          }
          if (['not-granted', 'folder-missing', 'folder-changed', 'unavailable'].includes(result.error)) {
            return stop(current, errors[result.error] ?? 'The folder API is unavailable.')
          }
        }
        if (selected(current)) update({})
        schedulePoll(current)
      } catch {
        if (!isLive(current)) return
        if (bridgeRequest && current.retriesUsed < current.retries &&
            performance.now() + RETRY_DELAY_MS < current.lastContact + current.heartbeatSeconds * 1000) {
          current.retriesUsed++
          update({})
          schedulePoll(current, RETRY_DELAY_MS)
          return
        }
        stop(current, bridgeRequest ? errors['connection-lost'] : errors.connection)
      }
    }

    const owningView = (current, selection) => !disposed && opening === selection && view.selection === selection &&
      outcomeKey(selection) === outcomeKey(current) && selection.runtimeId === current.runtimeId &&
      isLive(current)

    async function checkReview(current, authorized) {
      if (!authorized() || !await resolveSession(current) || !authorized()) return false
      const grants = await ctx.files.folders()
      return authorized() && grants.some(grant => grant.id === current.folder.id)
    }

    async function settle(current, id, status) {
      for (let attempt = 0; attempt < 2 && !disposed && sameRoute(current); attempt++) {
        try {
          if ((await request(current, 'settle', { id, status }))?.ok === true) return true
        } catch {
          // Retry the receipt only. The approval and native write are single-use.
        }
      }
      return false
    }

    async function save(current, authorized, { id, path, text, base, updating, writeLimit }) {
      let writing = false
      try {
        if (!await checkReview(current, authorized) || !authorized()) return 'failed'
        if ((await request(current, 'begin_apply', { id }))?.ok !== true) return 'failed'
        if (!await checkReview(current, authorized) || !authorized()) return 'failed'
        if (updating) {
          const fresh = await readText(ctx.files, current, path, writeLimit)
          if (!fresh.ok || fresh.text !== base) return 'conflict'
          const grants = await ctx.files.folders()
          if (!grants.some(grant => grant.id === current.folder.id)) return 'failed'
        }
        if (!authorized()) return 'failed'
        writing = true
        const result = updating
          ? await ctx.files.writeText(current.folder.id, path, text)
          : await ctx.files.writeText(current.folder.id, path, text, { exclusive: true })
        if (result?.ok === true) return 'applied'
        if (result?.error === 'exists' || result?.error === 'not-found') return 'conflict'
        if (['not-granted', 'folder-missing', 'folder-changed', 'unavailable', 'invalid-path', 'protected',
          'sensitive-file', 'too-large', 'not-a-file', 'is-directory'].includes(result?.error)) return 'failed'
        return 'uncertain'
      } catch {
        return writing ? 'uncertain' : 'failed'
      }
    }

    function review(current, authorized, item, apply) {
      if (!authorized() || !item.pending ||
          current.proposals.get(item.proposal.id) !== item) return
      if (apply && queuedSaves >= SAVE_LIMIT) {
        update({ activity: 'The save queue is full. Wait for a save to finish.' })
        return
      }
      item.pending = false
      outcomes.delete(outcomeKey(current))
      update({})
      const id = item.proposal.id
      async function finish(status) {
        const sent = await settle(current, id, status)
        if (disposed) return
        current.proposals.delete(id)
        const message = status === 'uncertain' ? 'Save outcome uncertain. Inspect the file before trying again.'
          : status === 'applied' ? 'Saved.'
          : status === 'conflict' ? 'File conflict. Request a new proposal.'
          : status === 'rejected' ? 'Proposal rejected.' : 'Save could not start.'
        const key = outcomeKey(current)
        outcomes.delete(key)
        outcomes.set(key, message + (sent ? '' : ' The gateway did not confirm the receipt.'))
        if (outcomes.size > 16) outcomes.delete(outcomes.keys().next().value)
        update({})
      }
      if (!apply) return finish('rejected')
      queuedSaves++
      const outcome = saveQueue.then(() => {
        const proposal = current.proposals.get(id)?.proposal
        return proposal ? save(current, authorized, proposal) : 'failed'
      })
      saveQueue = outcome.then(() => { queuedSaves-- })
      return outcome.then(finish)
    }

    async function readAccess(selection) {
      const reply = await request(selection, 'access_request', { sessionId: selection.sessionId })
      if (reply?.ok !== true) throw new Error('Drawbridge could not check the access request.')
      const access = reply.request
      if (!access) return null
      if (!/^[a-f0-9]{32}$/u.test(access.id) || !Array.isArray(access.permissions) ||
          !access.permissions.includes('read') ||
          !access.permissions.every(permission => ['read', 'create', 'update'].includes(permission)) ||
          !validInteger(access.durationSeconds, 0, MAX_DURATION_SECONDS) ||
          (access.folderHint != null && (typeof access.folderHint !== 'string' || access.folderHint.length > 4096))) {
        throw new Error('Invalid Drawbridge access request.')
      }
      return access
    }

    const requestKey = (chat, requestId) => JSON.stringify([outcomeKey(chat), requestId])

    function cacheRequest(key, result, ttl = Infinity) {
      requestCache.delete(key)
      requestCache.set(key, { result, expiresAt: performance.now() + ttl })
      if (requestCache.size > 64) requestCache.delete(requestCache.keys().next().value)
      update({})
    }

    function loadCardRequest(key, runtimeId, sessionId, requestId) {
      const cached = requestCache.get(key)
      if (cached?.pending === runtimeId || cached?.expiresAt > performance.now()) return
      const pending = { pending: runtimeId }
      requestCache.set(key, pending)
      if (requestCache.size > 64) requestCache.delete(requestCache.keys().next().value)
      void (async () => {
        try {
          const chat = await focusedChat(runtimeId)
          if (chat.sessionId !== sessionId || requestKey(chat, requestId) !== key) throw new Error(errors.identity)
          const access = await readAccess(chat)
          const matched = access?.id === requestId ? access : null
          const folder = await findRequestedFolder(matched)
          if (disposed || requestCache.get(key) !== pending) return
          if (!stillFocused(chat)) {
            requestCache.delete(key)
            return
          }
          cacheRequest(key, { access: matched, folder }, matched ? 15000 : Infinity)
        } catch {
          if (!disposed && requestCache.get(key) === pending) {
            cacheRequest(key, { error: 'Could not check this request. Open Drawbridge to try again.' }, 2000)
          }
        }
      })()
    }

    function requestedSettings(access) {
      const canWrite = typeof ctx.files.writeText === 'function'
      return {
        durationSeconds: access.durationSeconds,
        allowCreate: canWrite && access.permissions.includes('create'),
        allowUpdate: canWrite && access.permissions.includes('update'),
      }
    }

    async function findRequestedFolder(access) {
      if (!access?.folderHint) return null
      const matches = (await ctx.files.folders().catch(() => [])).filter(folder =>
        folder.id !== 'data' && folder.path === access.folderHint)
      return matches.length === 1 ? matches[0] : null
    }

    async function lookupAccess(selection) {
      const stillSelected = () => !disposed && opening === selection && view.selection === selection && sameRoute(selection)
      if (!stillSelected()) return
      try {
        if (!await resolveSession(selection) || !stillSelected()) return
        const accessRequest = await readAccess(selection)
        if (stillSelected()) update({ accessRequest })
      } catch {
        // An unavailable request lookup does not prevent a manual grant.
      }
    }

    async function changeAccess(current, selection) {
      if (view.changing || !owningView(current, selection)) return
      update({
        changing: true, folder: current.folder, durationSeconds: current.durationSeconds,
        heartbeatSeconds: current.heartbeatSeconds, pollIntervalMs: current.pollIntervalMs, retries: current.retries,
        ...fileLimits(current),
        allowUpdate: current.allowUpdate, allowCreate: current.allowCreate, activity: '',
      })
      const receipt = await stop(current, 'Choose permissions and start a new grant.')
      if (view.selection !== selection || disposed) return
      update({ changing: false, ...(receipt?.ok !== true ? { message: 'The gateway did not confirm that the previous grant ended.' } : {}) })
    }

    async function focusedChat(runtimeId) {
      if (disposed) throw new Error(errors.identity)
      const owner = host.state.focusedSessionOwner.get()
      const current = {
        runtimeId,
        sessionId: host.state.focusedStoredSessionId.get(),
        connection: owner?.connectionId,
        profile: owner?.profile,
        epoch: gatewayActivationEpoch(),
      }
      // Canonical gateways can use the stored conversation ID as the runtime ID.
      // resolveSession still requires a unique row matching both IDs.
      if (!runtimeId || !current.sessionId || !current.connection || !current.profile) {
        throw new Error(errors.identity)
      }
      if (host.state.focusedSessionId.get() === runtimeId &&
          host.activeConnectionId() === current.connection && host.state.profile.get() !== current.profile) {
        throw new Error('This chat belongs to the “' + current.profile +
          '” profile. Select that profile in Hermes, then open Drawbridge from this chat again.')
      }
      if (disposed || !stillFocused(current)) throw new Error(errors.identity)
      const row = await resolveSession(current)
      if (disposed || !row || !stillFocused(current)) throw new Error(errors.identity)
      current.title = typeof row.title === 'string' && row.title.trim() ? row.title : current.sessionId
      return current
    }

    async function openChat(runtimeId, requestId = null, expectedChat = null) {
      const sequence = ++openSequence
      const current = await focusedChat(runtimeId)
      if (expectedChat && current.sessionId !== expectedChat) throw new Error(errors.identity)
      const accessRequest = requestId ? await readAccess(current) : null
      const suggestedFolder = await findRequestedFolder(accessRequest)
      if (sequence !== openSequence) return
      if (disposed || !stillFocused(current)) throw new Error(errors.identity)
      if (requestId && accessRequest?.id !== requestId) throw new Error('This Drawbridge access request has ended.')
      showFolderReview(current, accessRequest, suggestedFolder)
      if (!requestId) void lookupAccess(current)
    }

    function showFolderReview(current, accessRequest, folder, message = '') {
      opening = current
      const shared = sharesFor(current)[0]
      update({
        selection: current, folder: shared?.folder ?? folder,
        durationSeconds: shared?.durationSeconds ??
          readSetting('durationSeconds', SHARE_DEFAULTS.durationSeconds, 0, MAX_DURATION_SECONDS),
        ...connectionSettings(),
        allowUpdate: shared?.allowUpdate ?? false, allowCreate: shared?.allowCreate ?? false,
        picking: false, changing: false, accessRequest, message, activity: '',
        ...(!shared && accessRequest ? requestedSettings(accessRequest) : {}),
      })
      host.navigate(CHAT_ROUTE)
    }

    function AccessRequestCard({ requestId, sessionId }) {
      useSyncExternalStore(subscribe, () => revision)
      const focused = useSyncExternalStore(host.state.focusedStoredSessionId.listen, host.state.focusedStoredSessionId.get)
      const runtimeId = useSyncExternalStore(host.state.focusedSessionId.listen, host.state.focusedSessionId.get)
      const owner = useSyncExternalStore(host.state.focusedSessionOwner.listen, host.state.focusedSessionOwner.get)
      const [result, setResult] = useState(null)
      const [openingRequest, setOpeningRequest] = useState(false)
      const isFocused = focused === sessionId && Boolean(runtimeId && owner?.connectionId && owner?.profile)
      const key = isFocused ? requestKey({ connection: owner.connectionId, profile: owner.profile, sessionId }, requestId) : null
      useEffect(() => {
        if (key) loadCardRequest(key, runtimeId, sessionId, requestId)
      }, [key, runtimeId, requestId, sessionId])

      const cached = key && requestCache.get(key)
      const actionResult = isFocused && result?.requestId === requestId && result.runtimeId === runtimeId ? result : null
      const current = actionResult ?? cached?.result ?? null
      const access = current?.access
      const chatIdentity = key && { connection: owner.connectionId, profile: owner.profile, sessionId }
      const folder = current?.folder
      const settings = access && requestedSettings(access)
      const chatShares = chatIdentity ? sharesFor(chatIdentity) : []
      const hasShare = chatShares.length > 0
      const [existing] = chatShares
      const upgrading = chatShares.length === 1 && existing.phase === 'sharing' &&
        !existing.allowCreate && !existing.allowUpdate && (settings?.allowCreate || settings?.allowUpdate) &&
        folder?.id === existing.folder.id && folder.path === existing.folder.path
      const supportsRequestedPermissions = access &&
        access.permissions.every(permission => permissionsFor(settings).includes(permission))
      const canApprove = folder && (!hasShare || upgrading) && supportsRequestedPermissions
      const canConfirm = !folder && !hasShare && supportsRequestedPermissions && Boolean(access.folderHint)
      const reviewReason = upgrading
        ? 'This replaces the current read-only share with the permissions and duration shown above.'
        : hasShare
        ? 'This chat already has a share. Open Drawbridge to review or change its access.'
        : !supportsRequestedPermissions
          ? 'This Desktop build cannot grant the requested write permissions. Open Drawbridge to review available access.'
          : canConfirm ? 'Hermes Desktop asks you to confirm a new folder in its folder picker.'
            : !folder ? 'Choose the folder in Drawbridge to confirm which folder to share.' : null
      const summary = access
        ? 'Read and list files' + (access.permissions.includes('create') ? ', create files' : '') +
          (access.permissions.includes('update') ? ', update files' : '') + ' · ' +
          (access.durationSeconds ? access.durationSeconds + ' seconds' : 'no time limit')
        : current?.error ?? current?.notice ?? (current ? 'This request is no longer pending.' :
          isFocused ? 'Checking request…' : 'Focus this chat to review the request.')
      return h('section', {
        className: 'flex flex-col gap-2 rounded-lg border p-3 text-sm',
        style: { marginBlockStart: '0.75rem' }, 'aria-label': 'Drawbridge folder access request',
      },
        h('strong', { className: 'flex items-center gap-2' },
          sdk.Codicon && h(sdk.Codicon, { name: 'bell', 'aria-hidden': true }), 'Drawbridge folder access request'),
        h('p', { role: 'status' }, summary),
        access && current.error && h('p', { role: 'alert' }, current.error),
        access?.folderHint && folderBreadcrumbs(access.folderHint),
        access && reviewReason && h('p', { className: 'text-(--ui-text-secondary)' }, reviewReason),
        access && h('div', { className: 'flex flex-wrap gap-2' }, h(sdk.Button ?? 'button', {
          type: 'button', size: 'sm', variant: canApprove || canConfirm ? undefined : 'outline', disabled: openingRequest,
          onClick: async () => {
            setOpeningRequest(true)
            try {
              if (canApprove || canConfirm) {
                const chat = await focusedChat(runtimeId)
                if (requestKey(chat, requestId) !== key) throw new Error(errors.identity)
                let fresh = await readAccess(chat)
                if (!stillFocused(chat)) throw new Error(errors.identity)
                let pickedFolder
                if (canConfirm && fresh?.id === requestId) {
                  const picked = await ctx.files.requestFolder()
                  if (!stillFocused(chat)) throw new Error(errors.identity)
                  if (!picked?.ok || !picked.folder || picked.folder.id === 'data') return
                  pickedFolder = Object.freeze({ ...picked.folder })
                  fresh = await readAccess(chat)
                }
                if (fresh?.id !== requestId) {
                  setResult(null)
                  cacheRequest(key, { notice: 'This request is no longer pending.' })
                  return
                }
                const match = await findRequestedFolder(fresh)
                if (!stillFocused(chat)) throw new Error(errors.identity)
                if (fresh.folderHint !== access.folderHint || fresh.durationSeconds !== access.durationSeconds ||
                    fresh.permissions.join(',') !== access.permissions.join(',')) {
                  setResult(null)
                  cacheRequest(key, { access: fresh, folder: match }, 15000)
                  return
                }
                const liveShares = sharesFor(chat)
                if (upgrading ? liveShares.length !== 1 || liveShares[0] !== existing : liveShares.length) {
                  throw new Error(errors['already-sharing'])
                }
                if (pickedFolder && pickedFolder.path !== fresh.folderHint) {
                  showFolderReview(chat, fresh, pickedFolder,
                    'You chose a different folder. Review the selected folder and permissions before sharing.')
                  return
                }
                const confirmed = pickedFolder ?? folder
                if (match?.id !== confirmed.id || match.path !== confirmed.path) {
                  setResult(null)
                  cacheRequest(key, { access: fresh, folder: match }, 15000)
                  return
                }
                const started = await startFolder(chat, {
                  ...settings, folder: match,
                  ...connectionSettings(),
                }, requestId, true, upgrading ? existing : undefined)
                if (!started) throw new Error('Could not share this folder. Check the gateway and try again.')
                setResult(null)
              } else {
                await openChat(runtimeId, requestId, sessionId)
              }
            } catch (error) {
              setResult({ requestId, runtimeId, access, folder, error: error.message })
            } finally {
              setOpeningRequest(false)
            }
          },
        }, canApprove ? (upgrading ? 'Approve upgrade and continue' : 'Approve and continue') : canConfirm
          ? 'Confirm folder' : folder || hasShare
          ? 'Review folder access' : 'Choose folder'), h(sdk.Button ?? 'button', {
          type: 'button', size: 'sm', variant: 'outline', disabled: openingRequest,
          onClick: async () => {
            setOpeningRequest(true)
            try {
              const chat = await focusedChat(runtimeId)
              if (chat.sessionId !== sessionId || !stillFocused(chat)) throw new Error(errors.identity)
              const reply = await request(chat, 'reject_access', { sessionId, id: requestId })
              if (reply?.ok !== true && reply?.error !== 'request-ended') throw new Error('Could not reject this request.')
              if (view.accessRequest?.id === requestId && selected(chat)) update({ accessRequest: null })
              setResult(null)
              cacheRequest(requestKey(chat, requestId), { notice: reply?.ok ? 'Request rejected.' : 'This request is no longer pending.' })
            } catch (error) {
              setResult({ requestId, runtimeId, access, folder, error: error.message })
            } finally {
              setOpeningRequest(false)
            }
          },
        }, 'Reject')),
      )
    }

    const folderDraft = () => ({
      folder: view.folder, durationSeconds: view.durationSeconds, heartbeatSeconds: view.heartbeatSeconds,
      pollIntervalMs: view.pollIntervalMs, retries: view.retries,
      ...fileLimits(view),
      allowUpdate: view.allowUpdate, allowCreate: view.allowCreate,
    })

    async function choose(selection) {
      if (disposed || view.selection !== selection || view.picking || view.changing || sharesFor(selection).length) return
      if (!sameRoute(selection)) return update({ message: 'Reconnect to the chat gateway before choosing a folder.' })
      update({ picking: true, message: '' })
      try {
        const picked = await ctx.files.requestFolder()
        if (disposed || view.selection !== selection) return
        if (!sameRoute(selection)) {
          return update({ message: 'The chat gateway disconnected while the folder picker was open. Reconnect and try again.' })
        }
        if (!picked?.ok || !picked.folder || picked.folder.id === 'data') {
          return update({ message: picked?.message ?? 'No folder selected.' })
        }
        update({ folder: Object.freeze({ ...picked.folder }), activity: '' })
      } catch {
        if (!disposed && view.selection === selection) {
          update({ message: 'Desktop could not open the folder picker.' })
        }
      } finally {
        if (!disposed && view.selection === selection) update({ picking: false })
      }
    }

    async function start(selection) {
      if (disposed || opening !== selection || view.selection !== selection || view.picking || view.changing || !view.folder ||
          sharesFor(selection).length || !sameRoute(selection)) return
      await startFolder(selection, folderDraft(), view.accessRequest?.id)
    }

    async function continueAfterGrant(current, selection, inline) {
      const canContinue = () => (inline ? stillFocused(current) : view.selection === selection) && isLive(current)
      if (!isLive(current) || (!inline && view.selection !== selection)) return
      try {
        if (typeof host.composer?.submit === 'function' && (inline || typeof host.openSession === 'function')) {
          if (!inline) await host.openSession(current.sessionId, {
            profile: current.profile, keepAllProfilesScope: true,
          })
          if (canContinue() && stillFocused(current) &&
              host.composer.submit(current.sessionId,
                'I granted Drawbridge folder access. Continue the task that requested access, using the permissions I granted.')) return
        }
      } catch {
        // Grant registration has already succeeded. A chat navigation failure does not undo it.
      }
      if (disposed || !isLive(current) || (!inline && view.selection !== selection)) return
      const message = 'Folder shared. Return to the chat and ask Hermes to continue.'
      if (inline) cacheRequest(requestKey(current, current.requestId), { notice: message })
      else update({ activity: message })
      host.notify?.({ kind: 'warning', message })
    }

    async function startFolder(selection, draft, requestId, inline = false, replacing = null) {
      const current = {
        ...selection,
        ...draft,
        requestId,
        folderName: replacing?.folderName ?? folderName(draft.folder, selection),
        retriesUsed: 0,
        allowUpdate: typeof ctx.files.writeText === 'function' && draft.allowUpdate,
        allowCreate: typeof ctx.files.writeText === 'function' && draft.allowCreate,
        proposals: new Map(),
        expiresAt: draft.durationSeconds ? performance.now() + draft.durationSeconds * 1000 : Infinity,
        token: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
        phase: 'starting',
      }
      shares.set(current.token, current)
      update({ message: '', activity: '' })
      try {
        const grants = await ctx.files.folders()
        if (!isLive(current)) return
        if (!grants.some(grant => grant.id === current.folder.id && (!inline || grant.path === current.folder.path))) {
          stop(current, errors['not-granted'])
          return false
        }
        const row = await resolveSession(current)
        if (!isLive(current)) return
        if (!row || (inline && !stillFocused(current))) {
          stop(current, errors.identity)
          return false
        }
        const sentAt = performance.now()
        const reply = await request(current, 'start', {
          sessionId: current.sessionId, durationSeconds: current.durationSeconds,
          folder: current.folderName,
          heartbeatSeconds: current.heartbeatSeconds,
          limits: fileLimits(current),
          permissions: permissionsFor(current), ...(requestId ? { requestId } : {}),
          ...(replacing ? { replaceToken: replacing.token } : {}),
        })
        if (reply?.ok === true && replacing) stop(replacing, 'Folder access upgraded.', false)
        if (!isLive(current)) {
          if (reply?.ok === true && sameRoute(current)) void request(current, 'stop').catch(() => {})
          return
        }
        if (reply?.ok !== true) {
          if (reply?.error === 'request-ended' && requestId) {
            cacheRequest(requestKey(current, requestId), { notice: 'This request is no longer pending.' })
            if (view.selection === selection) update({ accessRequest: null })
          }
          stop(current, errorMessage(reply?.error))
          return false
        }
        if (!Object.keys(FILE_LIMIT_DEFAULTS).every(key => validInteger(reply.limits?.[key], 1, current[key]))) {
          stop(current, 'The backend did not confirm the share’s file size limits. Update both Drawbridge components.')
          return false
        }
        Object.assign(current, fileLimits(reply.limits))
        current.phase = 'sharing'
        current.lastContact = sentAt
        if (requestId) cacheRequest(requestKey(current, requestId), { notice: 'Folder access granted.' })
        update(view.selection === selection ? { accessRequest: null } : {})
        void poll(current)
        if (requestId) await continueAfterGrant(current, selection, inline)
        return true
      } catch {
        stop(current, errors.connection)
      }
    }

    function SharingIndicator() {
      useSyncExternalStore(subscribe, () => revision)
      const count = [...shares.values()].filter(current => current.phase === 'sharing').length
      if (!count) return null
      return h('button', { type: 'button', onClick: () => host.navigate(ROUTE) }, count === 1 ? 'Folder shared' : count + ' folders shared')
    }

    function proposalCards(current, onReview) {
      return [...(current?.proposals.values() ?? [])].filter(item => !item.proposal.nativeReview).map(item => {
        const { id, path, updating } = item.proposal
        return h('section', { key: id, className: 'flex min-w-0 flex-col gap-2 rounded-md border p-3' },
          h('h2', { className: 'break-all font-semibold' }, (updating ? 'Update ' : 'Create ') + displayText(path)),
          h('p', { className: 'break-all' }, 'Folder ' + displayText(current.folder.path)),
          h('p', null, 'Full text diff. Escapes mark tabs, line endings, and invisible characters.'),
          h('pre', { className: 'max-h-64 overflow-auto whitespace-pre-wrap break-all', dir: 'ltr', tabIndex: 0 },
            proposalDiff(item.proposal)),
          h('div', { className: 'flex justify-end gap-2' },
            h(sdk.Button ?? 'button', { type: 'button', variant: 'outline', disabled: !item.pending, onClick: () => onReview(item, false) }, 'Reject'),
            h(sdk.Button ?? 'button', { type: 'button', disabled: !item.pending, onClick: () => onReview(item, true) }, 'Apply once'),
          ),
        )
      })
    }

    function Panel({ overview = false }) {
      useSyncExternalStore(subscribe, () => revision)
      const selection = overview ? null : view.selection
      const chatShares = selection ? sharesFor(selection) : []
      const current = chatShares[0]
      const editing = !current
      const folder = editing ? view.folder : current.folder
      const status = current?.phase === 'sharing'
        ? (current.retriesUsed > 0 ? 'Reconnecting share with ' : 'Sharing with ') + current.title + ' · ' +
          current.folderName + ' · ' + accessLabel(current) + ' · ' +
          (current.durationSeconds ? Math.max(0, Math.ceil((current.expiresAt - performance.now()) / 1000)) +
            ' seconds remaining' : 'No time limit')
        : current?.phase === 'starting' ? 'Connecting…' : view.message || 'Sharing is off.'
      const otherShares = [...shares.values()].filter(share => share !== current)
      const disabled = !selection || !editing || chatShares.some(share => share.phase === 'starting') || view.picking || view.changing
      const settingsDisabled = Boolean(selection && disabled)
      const settingValues = current ?? (selection ? view : shareDefaults())
      const accessRequest = view.accessRequest
      const requestSettings = accessRequest && requestedSettings(accessRequest)
      const requestSettingsDiffer = requestSettings && Object.entries(requestSettings).some(([key, value]) => view[key] !== value)
      const outcome = selection && outcomes.get(outcomeKey(selection))
      const settings = [
        ['durationSeconds', 'Share duration in seconds (0 means no time limit)', 0, MAX_DURATION_SECONDS],
        ['heartbeatSeconds', 'Heartbeat timeout in seconds', 5, 120],
        ['pollIntervalMs', 'Poll interval in milliseconds', MIN_POLL_INTERVAL_MS,
          maxPollInterval(settingValues.heartbeatSeconds)],
        ['retries', 'Connection retries', 0, 10],
        ['readLimitKiB', 'Maximum read size in KiB', 1, FILE_LIMIT_DEFAULTS.readLimitKiB],
        ['reviewedWriteLimitKiB', 'Maximum reviewed write size in KiB', 1, FILE_LIMIT_DEFAULTS.reviewedWriteLimitKiB],
        ['sessionWriteLimitKiB', 'Maximum session-approved write size in KiB', 1, FILE_LIMIT_DEFAULTS.sessionWriteLimitKiB],
      ]
      const deleteReason = 'Delete is disabled until an official Hermes Desktop release includes the Windows hard-link Trash fix (PR #150202).'
      const permissionSwitch = (label, checked, disabled, onChange) => {
        const props = { 'aria-label': label, checked, disabled }
        return sdk.Switch
          ? h(sdk.Switch, { ...props, onCheckedChange: onChange })
          : h('input', { ...props, type: 'checkbox', onChange: onChange && (event => onChange(event.target.checked)) })
      }
      const permissionRow = 'flex items-center justify-between gap-3 py-1'
      function lockedPermission(label, checked, reason) {
        const trigger = h('span', {
          className: 'inline-flex shrink-0', tabIndex: 0,
          'aria-label': label + '. ' + reason, title: sdk.Tip ? undefined : reason,
        }, h('span', { className: 'pointer-events-none inline-flex' }, permissionSwitch(label, checked, true)))
        return h('div', { className: permissionRow }, label,
          sdk.Tip ? h(sdk.Tip, { label: reason }, trigger) : trigger)
      }
      const Button = sdk.Button ?? 'button'
      const Input = sdk.Input ?? 'input'
      const card = 'flex min-w-0 flex-col gap-3 rounded-lg border p-4'
      const muted = 'text-(--ui-text-secondary)'
      return h('section', { className: 'mx-auto flex w-full max-w-2xl flex-col gap-4 p-6 text-sm' },
        h('header', { className: 'flex flex-col gap-1' },
          h('h1', { className: 'flex items-center gap-2 text-xl font-semibold' },
            sdk.Codicon && h(sdk.Codicon, { name: 'folder-opened', 'aria-hidden': true }), 'Drawbridge'),
          h('p', { className: muted }, 'Share a local folder with one Hermes chat.'),
        ),
        (!selection || otherShares.length > 0) && h('section', { className: card, 'aria-label': 'Active shares' },
          h('h2', { className: 'font-semibold' }, 'Active shares'),
          otherShares.length === 0 ? h('div', { className: 'flex flex-col gap-1' },
            h('h3', { className: 'font-medium' }, 'No active shares'),
            h('p', { className: muted }, 'To share a folder, open the chat you want and click ',
              h('strong', null, 'Drawbridge'), ' beside its message box.'),
          ) : h('div', { className: 'overflow-x-auto' },
            h('table', { className: 'w-full text-left' },
              h('thead', { className: muted }, h('tr', null,
                ...['Chat', 'Folder', 'Profile', 'Access', 'Action'].map(label => h('th', { key: label, scope: 'col', className: 'px-2 py-1 font-medium' }, label)),
              )),
              h('tbody', null, ...otherShares.map(share => h('tr', {
                key: JSON.stringify([outcomeKey(share), share.folderName]), className: 'border-t',
              },
                h('td', { className: 'px-2 py-2' }, share.title),
                h('td', { className: 'px-2 py-2' }, share.folderName),
                h('td', { className: 'px-2 py-2' }, share.profile),
                h('td', { className: 'px-2 py-2' }, accessLabel(share)),
                h('td', { className: 'flex flex-wrap gap-2 px-2 py-2' }, selected(share) && h(Button, {
                  type: 'button', size: 'sm', variant: 'outline',
                  'aria-label': 'Change access for ' + share.folderName,
                  onClick: () => changeAccess(share, selection),
                }, 'Change access'), h(Button, {
                  type: 'button', size: 'sm', variant: 'outline', 'aria-label': 'Stop sharing ' + share.folderName + ' with ' + share.title,
                  onClick: () => stop(share),
                }, 'Stop')),
              ))),
            ),
          ),
        ),
        !selection && view.message && h('p', { role: 'status' }, view.message),
        selection && h('section', { className: card, 'aria-label': 'Folder access' },
          h('h2', { className: 'font-semibold' }, 'Folder access'),
          h('p', { role: 'status' }, status),
          current?.phase === 'sharing' && h('p', { className: muted }, 'Switching profiles ends access.'),
          current && view.message && h('p', { className: muted }, view.message),
          h('p', { className: muted }, 'Chat: ', h('strong', null, selection.title)),
          view.activity && h('p', { className: 'break-all ' + muted }, 'Last request · ' + view.activity),
          outcome && h('p', { 'aria-live': 'polite' }, outcome),
          current?.phase === 'sharing' && h('div', { className: 'flex flex-wrap gap-2' },
            h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => changeAccess(current, selection) }, 'Change access'),
            h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => stop(current) }, 'Stop sharing'),
          ),
        ),
        selection && h('section', { className: card, 'aria-label': 'Folder and permissions' },
          h('h2', { className: 'font-semibold' }, 'Folder and permissions'),
          folder?.path ? folderBreadcrumbs(folder.path) : h('p', { className: muted }, 'Choose a dedicated folder to share.'),
          accessRequest && editing && h('div', { className: 'flex flex-wrap items-center gap-2' },
            h('p', { className: muted }, 'Share duration · ' +
              (view.durationSeconds ? view.durationSeconds + ' seconds' : 'No time limit')),
            requestSettingsDiffer && h(Button, { type: 'button', size: 'sm', variant: 'outline', disabled,
              onClick: () => update(requestSettings) }, 'Use requested settings'),
          ),
          h('div', { className: 'flex flex-wrap gap-2' },
            editing && h(Button, { type: 'button', variant: 'outline', disabled, onClick: () => choose(selection) },
              folder ? 'Change folder' : 'Choose folder'),
            editing && h(Button, { type: 'button', disabled: disabled || !folder, onClick: () => start(selection) },
              accessRequest ? 'Share and continue' : 'Start sharing'),
          ),
          h('fieldset', { disabled, className: 'flex flex-col gap-2' },
          h('legend', { className: 'mb-2 font-medium' }, 'Folder permissions'),
          lockedPermission('Read and list files', true, 'Always included when sharing a folder.'),
          ...[['allowCreate', 'Create new files'], ['allowUpdate', 'Update existing files']].map(([field, label]) =>
            h('label', { key: field, className: permissionRow }, label,
              permissionSwitch(label, editing ? view[field] : current[field],
                disabled || typeof ctx.files.writeText !== 'function', checked => {
                if (!disabled && view.selection === selection) {
                  update({ [field]: checked })
                }
              })),
          ),
          lockedPermission('Delete files', false, deleteReason),
          ),
        ),
        h('details', { className: 'rounded-lg border p-4', open: !selection || undefined },
          h('summary', { className: 'cursor-pointer font-semibold' }, selection ? 'Share settings' : 'Share defaults'),
          !selection && h('p', { className: 'mt-2 ' + muted }, 'These settings apply to new shares.'),
          h('fieldset', { disabled: settingsDisabled, className: 'mt-3 flex flex-col gap-2' },
          ...settings.map(([key, label, min, max]) => {
            const saved = settingValues[key]
            return h('label', { key, className: 'flex flex-wrap items-center justify-between gap-2' }, label + ' ',
              h(Input, {
                key: saved, type: 'number', min, max, step: 1, defaultValue: saved, className: 'w-24',
                onBlur: ({ currentTarget }) => {
                  const value = currentTarget.valueAsNumber
                  if (settingsDisabled || (!overview && view.selection !== selection) ||
                      !validInteger(value, min, max)) {
                    currentTarget.value = String(saved)
                    return
                  }
                  if (value === saved) return
                  ctx.storage.set(key, value)
                  const changes = { [key]: value }
                  if (key === 'heartbeatSeconds' && settingValues.pollIntervalMs > maxPollInterval(value)) {
                    changes.pollIntervalMs = maxPollInterval(value)
                    ctx.storage.set('pollIntervalMs', changes.pollIntervalMs)
                  }
                  update(overview ? {} : changes)
                },
              }),
            )
          }),
          h(sdk.Button ?? 'button', {
            type: 'button', size: 'sm', variant: 'outline', className: 'self-start', disabled: settingsDisabled,
            onClick: () => {
              if (settingsDisabled || (!overview && view.selection !== selection)) return
              for (const key of Object.keys(SHARE_DEFAULTS)) ctx.storage.remove(key)
              update(overview ? {} : SHARE_DEFAULTS)
            },
          }, 'Reset to defaults'),
          ),
        ),
        ...chatShares.flatMap(share => proposalCards(share, (item, apply) =>
          review(share, () => owningView(share, selection), item, apply))),
      )
    }

    const renderPanel = overview => supported
      ? h(Panel, { overview })
      : h('p', null, 'This build of Hermes Desktop does not support chat-scoped Drawbridge.')
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: ROUTE },
      render: () => renderPanel(true),
    })
    ctx.register({
      id: 'chat-page',
      area: ROUTES_AREA,
      data: { path: CHAT_ROUTE },
      render: () => renderPanel(false),
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: ROUTE, label: 'Drawbridge', codicon: 'folder-opened' },
    })
    ctx.register({
      id: 'sharing-indicator',
      area: STATUSBAR_AREAS.right,
      render: () => h(SharingIndicator),
    })
    if (supported) {
      if (typeof sdk.TRANSCRIPT_DIRECTIVE_AREA === 'string') {
        ctx.register({
          id: 'access-request-card',
          area: sdk.TRANSCRIPT_DIRECTIVE_AREA,
          data: {
            name: 'drawbridge-access',
            render: ({ attrs, sessionId, streaming }) =>
              !streaming && typeof sessionId === 'string' && /^[a-f0-9]{32}$/u.test(attrs?.id)
                ? h(AccessRequestCard, { requestId: attrs.id, sessionId })
                : null,
          },
        })
      }
      ctx.register({
        id: 'chat-control',
        area: COMPOSER_AREAS.microActions,
        data: {
          resolve: ({ sessionId }) => sessionId ? [{
            id: 'drawbridge', label: 'Drawbridge', icon: 'folder-opened',
            run: runtimeId => {
              if (runtimeId !== sessionId) throw new Error(errors.identity)
              return openChat(runtimeId)
            },
          }] : [],
        },
      })
      const onRouteChange = () => {
        for (const current of shares.values()) {
          if (!sameRoute(current)) stop(current, errors['route-changed'])
        }
        if (view.selection && !routeMatches(view.selection)) {
          update({ selection: null, folder: null, picking: false, activity: '', message: errors['route-changed'] })
        }
      }
      for (const atom of [host.state.connectionId, host.state.profile, host.state.gateway]) {
        ctx.onDispose(atom.listen(onRouteChange))
      }
    }
    ctx.onDispose(() => {
      disposed = true
      for (const current of shares.values()) stop(current, 'Drawbridge was unloaded.')
    })
  },
}
