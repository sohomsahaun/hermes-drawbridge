import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, link, realpath, unlink, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'

const source = path.resolve(process.argv[2])
const workspace = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const fixture = await mkdtemp(path.join(workspace, '.smoke-'))
assert.equal(path.dirname(await realpath(fixture)), workspace)
const escape = path.join(fixture, 'shared', 'escape')
let escapeCreated = false
const broker = spawn(process.env.DRAWBRIDGE_PYTHON || 'python', [
  '-B', '-X', 'utf8', path.join(workspace, 'tests/broker_fixture.py'), source, fixture,
], { stdio: ['pipe', 'pipe', 'inherit'] })

let nextId = 0
const pending = new Map()
createInterface({ input: broker.stdout }).on('line', line => {
  const { id, result, exception } = JSON.parse(line)
  const { resolve, reject } = pending.get(id)
  pending.delete(id)
  if (exception) reject(new Error(exception))
  else resolve(result)
})
const exited = new Promise(resolve => broker.on('close', resolve))
broker.on('close', code => {
  for (const { reject } of pending.values()) reject(new Error(`Fixture exited with ${code}`))
})

const chatA = '20261106_chat_a'
const chatB = '20261106_chat_b'
const runtimeA = 'runtime-a'
const runtimeB = 'runtime-b'

function call(kind, body, profile = 'primary', sessionId = chatA) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    broker.stdin.write(JSON.stringify({ id, kind, profile, sessionId, body }) + '\n')
  })
}

const tool = (op, relative, text, sessionId = chatA) => call('tool', { op, path: relative, text }, 'primary', sessionId)
const api = (action, token, extras = {}, profile) => call('api', { action, token, ...extras }, profile)

async function until(fn) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await fn()
    if (result) return result
    await delay(20)
  }
  throw new Error('Timed out waiting for the fixture')
}

function atom(initial) {
  const listeners = new Set()
  let value = initial
  return {
    get: () => value,
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const profile = atom('primary')
const gateway = atom('open')
const connectionId = atom('fixture-vps')
const focusedSessionId = atom(runtimeA)
const focusedStoredSessionId = atom(chatA)
const focusedSessionOwner = atom({ connectionId: connectionId.get(), profile: profile.get() })
const sessions = new Map([[runtimeA, chatA], [runtimeB, chatB]])
let epoch = 1
let pagePath = '/drawbridge'
globalThis.drawbridgeSdkFixture = {
  state: { profile, gateway, connectionId, focusedSessionId, focusedStoredSessionId, focusedSessionOwner },
  activeConnectionId: () => connectionId.get(),
  navigate: path => { pagePath = path },
  request: async (method) => {
    assert.equal(method, 'session.active_list')
    return { sessions: [...sessions].map(([id, session_key]) => ({ id, session_key, title: session_key })) }
  },
}
globalThis.drawbridgeEpochFixture = () => epoch

const asModule = code => 'data:text/javascript,' + encodeURIComponent(code)
const sourceUrl = pathToFileURL(source + path.sep).href
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@hermes/plugin-sdk') {
      return next(asModule(`
        export const host = globalThis.drawbridgeSdkFixture
        export const gatewayActivationEpoch = globalThis.drawbridgeEpochFixture
        export const ROUTES_AREA = 'routes'
        export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives'
        export const SIDEBAR_NAV_AREA = 'sidebar.nav'
        export const STATUSBAR_AREAS = { right: 'statusBar.right' }
        export const COMPOSER_AREAS = { microActions: 'composer.microActions' }
      `), context)
    }
    if (specifier === 'react') {
      return next(asModule(`
        export const createElement = (type, props, ...children) => ({ type, props, children })
        export const useSyncExternalStore = (_subscribe, snapshot) => snapshot()
        export const useEffect = effect => globalThis.drawbridgeCardEffects?.push(effect)
        export const useState = initial => [initial === null ? globalThis.drawbridgeAccessFixture ?? initial : initial, () => {}]
      `), context)
    }
    if (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith('.') && !path.extname(specifier)) {
      return next(specifier + '.ts', context)
    }
    return next(specifier, context)
  },
})

try {
  const { default: plugin } = await import('../desktop/plugin.js')
  const { createPluginFiles } = await import(new URL('apps/desktop/electron/plugin-files.ts', sourceUrl))
  const root = path.join(fixture, 'shared')
  const outside = path.join(fixture, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const hello = 'Hermes smoke marker — বাংলা ☕\r\nSecond line\r\n'
  await writeFile(path.join(root, 'hello.txt'), hello, 'utf8')
  await writeFile(path.join(outside, 'private.txt'), 'Private')
  const outsideSnapshot = async () => Promise.all(
    (await readdir(outside)).sort().map(async name => [
      name, createHash('sha256').update(await readFile(path.join(outside, name))).digest('hex'),
    ]),
  )
  const outsideBefore = await outsideSnapshot()
  await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
  escapeCreated = true
  await link(path.join(outside, 'private.txt'), path.join(root, 'hard.txt'))

  const native = createPluginFiles({
    userDataDir: () => path.join(fixture, 'app'),
    protectedRoots: () => [],
    trashItem: () => { throw new Error('Unexpected trash operation') },
  })
  const grants = () => native.grants(plugin.id)
  const run = (op, folder, relative, extra) => native.run(plugin.id, { op, folder, path: relative, ...extra })
  const contributions = new Map()
  const storage = new Map()
  const disposers = []
  const desktopKeys = new Map()
  const startBodies = new Map()
  let intercept = null
  let accessLookups = 0
  const scheduledDelays = new Set()
  let stopReply
  let readReply
  let nativeReads = 0
  let finished = 0
  let mutationCalls = 0
  let reviewedWrites = null
  let loseWriteReply = false
  let disconnectDuringWrite = false
  let disconnectDuringPick = false
  let cancelPicker = false
  let pickerPath
  const unexpectedMutation = () => {
    mutationCalls++
    throw new Error('Desktop called a native mutation API')
  }
  async function bridgeRequest(body, targetProfile) {
    if (body.action === 'access_request') accessLookups++
    if (body.action === 'start') {
      desktopKeys.set(body.sessionId, body.token)
      startBodies.set(body.sessionId, body)
    }
    if (body.action === 'finish') finished++
    const response = call('api', body, targetProfile)
    if (body.action === 'stop') stopReply = response
    const reply = await response
    return intercept ? intercept(body, reply) : reply
  }
  plugin.register({
    files: {
      requestFolder: () => {
        if (disconnectDuringPick) {
          gateway.set('closed')
          return { ok: false }
        }
        if (cancelPicker) return { ok: false }
        return native.addGrant(plugin.id, pickerPath ?? root)
      },
      folders: grants,
      release: async id => (await native.revoke(plugin.id, id)).removed > 0,
      list: (id, relative) => run('list', id, relative),
      readText: async (id, relative) => {
        nativeReads++
        const result = await run('readText', id, relative)
        return readReply ? readReply(result) : result
      },
      writeText: async (id, relative, text, options) => {
        if (!reviewedWrites) return unexpectedMutation()
        assert.equal(typeof text, 'string')
        const args = { text, ...options }
        reviewedWrites.push({ relative, ...args })
        const result = await run('writeText', id, relative, args)
        if (loseWriteReply) {
          assert.equal(result.ok, true)
          if (disconnectDuringWrite) gateway.set('closed')
          throw new Error('Simulated lost native write response')
        }
        return result
      },
      trash: unexpectedMutation,
    },
    rest: async (route, { body }) => {
      assert.equal(route, '/chat-bridge')
      return bridgeRequest(body, profile.get())
    },
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
    register: item => contributions.set(item.id, item),
    onDispose: callback => disposers.push(callback),
    setTimeout: (fn, ms) => {
      scheduledDelays.add(ms)
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  })

  function panel() {
    const route = [...contributions.values()].find(item => item.area === 'routes' && item.data.path === pagePath)
    const element = route.render()
    return element.type(element.props)
  }
  function find(node, predicate) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = find(child, predicate)
        if (result) return result
      }
      return undefined
    }
    return node && (predicate(node) ? node : find(node.children, predicate))
  }
  function button(label) {
    const findButton = text => find(panel(), node => node.type === 'button' && node.children[0] === text)
    const result = label === 'Choose folder' ? findButton('Change folder') ?? findButton('Choose folder') : findButton(label)
    assert(result, 'Missing Drawbridge button ' + label)
    return result
  }
  function status() {
    return find(panel(), node => node.props?.role === 'status')?.children[0] ?? ''
  }
  async function openChat(runtime, stored, ownerProfile = profile.get()) {
    focusedSessionId.set(runtime)
    focusedStoredSessionId.set(stored)
    focusedSessionOwner.set({ connectionId: connectionId.get(), profile: ownerProfile })
    const action = contributions.get('chat-control').data.resolve({ sessionId: runtime })[0]
    assert(action, 'Missing Drawbridge chat control')
    await action.run(runtime)
  }
  async function startSharing() {
    await button('Choose folder').props.onClick()
    await button('Start sharing').props.onClick()
    assert.match(status(), /Read-only/)
  }
  const expectError = async (result, error) => assert.deepEqual(await result, { ok: false, error })

  try {
    const emptyShares = find(panel(), node => node.props?.['aria-label'] === 'Active shares')
    assert(find(emptyShares, node => node.type === 'h3' && node.children[0] === 'No active shares'))
    assert(find(emptyShares, node => node.type === 'strong' && node.children[0] === 'Drawbridge'))
    assert.equal(find(panel(), node => node.props?.['aria-label'] === 'Folder and permissions'), undefined)
    assert.equal(find(panel(), node => node.type === 'fieldset').props.disabled, false)
    const overviewDuration = find(panel(), node => node.type === 'input' && node.props.defaultValue === 0)
    overviewDuration.props.onBlur({ currentTarget: { valueAsNumber: 45 } })
    assert.equal(storage.get('durationSeconds'), 45)
    await expectError(tool('read', 'hello.txt'), 'offline')
    await assert.rejects(openChat(runtimeA, chatB), /verify the chat/)
    await assert.rejects(openChat(runtimeA, runtimeA), /verify the chat/)
    await assert.rejects(openChat(runtimeA, chatA, 'other'), /belongs to the “other” profile/)
    await openChat(runtimeA, chatA)
    assert(find(panel(), node => node.type === 'h2' && node.children[0] === 'Folder access'))
    assert(find(panel(), node => node.type === 'input' && node.props.defaultValue === 45))
    button('Reset to defaults').props.onClick()
    disconnectDuringPick = true
    await button('Choose folder').props.onClick()
    assert.match(status(), /disconnected while the folder picker was open/)
    assert.equal(button('Choose folder').props.disabled, false)
    gateway.set('open')
    disconnectDuringPick = false
    await button('Choose folder').props.onClick()
    assert.equal(button('Change folder').props.disabled, false)
    assert.equal((await grants()).length, 1)
    await expectError(tool('read', 'hello.txt'), 'offline')
    await expectError(api('start', '0'.repeat(64), { writable: true }), 'invalid-request')
    await button('Start sharing').props.onClick()
    assert.match(status(), /Read-only/)
    globalThis.drawbridgeSdkFixture.navigate(contributions.get('nav').data.path)
    assert(find(panel(), node => node.type === 'h2' && node.children[0] === 'Active shares'))
    assert.equal(find(panel(), node => node.props?.['aria-label'] === 'Folder and permissions'), undefined)
    await openChat(runtimeA, chatA)

    await expectError(api('poll', '0'.repeat(64)), 'share-ended')
    await expectError(api('stop', '0'.repeat(64)), 'share-ended')
    await expectError(api('poll', undefined), 'invalid-request')
    await expectError(api('poll', desktopKeys.get(chatA), {}, 'other'), 'share-ended')
    await expectError(call('tool', { op: 'read', path: 'hello.txt' }, 'other'), 'offline')
    await expectError(tool('read', 'hello.txt', undefined, null), 'offline')
    await expectError(tool('read', 'hello.txt', undefined, chatB), 'offline')
    await expectError(call('tool', { op: 'read', path: 'hello.txt', sessionId: chatA }, 'primary', chatB), 'invalid-request')
    await expectError(tool('create', 'new.txt', 'text'), 'invalid-request')
    await expectError(tool('update', 'hello.txt', 'Replacement'), 'invalid-request')
    await expectError(tool('trash', 'hello.txt'), 'invalid-request')
    await expectError(call('tool', { op: 'propose_create', path: 'new.txt', text: 'New' }), 'permission-denied')
    await expectError(tool('read', 'hello.txt', 'Unexpected text'), 'invalid-request')
    await expectError(tool({ action: 'read' }, 'hello.txt'), 'invalid-request')
    await expectError(tool('read', ['hello.txt']), 'invalid-request')
    const unsafePaths = [
      '../outside/private.txt', '..\\outside/private.txt', path.join(outside, 'private.txt'),
      'C:/hello.txt', 'C:hello.txt', '//host/share', '\\\\host\\share',
      'hello.txt:stream', 'con.txt', 'COM¹.txt', 'nested/..', 'nested//hello.txt',
      'hello.txt.', 'hello.txt ', 'hello\0.txt',
    ]
    for (const unsafe of unsafePaths) {
      for (const op of ['read', 'list']) await expectError(tool(op, unsafe), 'invalid-request')
    }
    for (const malformed of [null, [], 'hello.txt', { op: 'read' }, { op: 'read', path: 'hello.txt', folder: ['other'] }]) {
      await expectError(call('tool', malformed), 'invalid-request')
    }
    await expectError(tool('shell', 'whoami'), 'invalid-request')
    const listed = await tool('list', '.')
    assert.equal(listed.ok, true)
    assert.ok(listed.entries.some(entry => entry.name === 'hello.txt'))
    assert.ok(!listed.entries.some(entry => entry.name === 'private.txt'))
    const readExpected = { ok: true, text: hello }
    assert.deepEqual(await tool('read', 'hello.txt'), readExpected)
    const originalGrant = desktopKeys.get(chatA)
    let lostPoll = false
    intercept = (body, reply) => {
      if (body.action === 'poll' && !lostPoll) {
        lostPoll = true
        throw new Error('Simulated lost heartbeat response')
      }
      return reply
    }
    await until(() => /Reconnecting share/.test(status()))
    await until(() => /Sharing with/.test(status()))
    intercept = null
    assert.deepEqual(await tool('read', 'hello.txt'), readExpected)
    assert.equal(desktopKeys.get(chatA), originalGrant)
    await expectError(tool('list', 'escape'), 'outside-folder')
    await expectError(tool('read', 'escape/private.txt'), 'outside-folder')
    const hardLink = await tool('read', 'hard.txt')
    assert.equal(hardLink.ok, false)
    assert.ok(['protected', 'not-a-file'].includes(hardLink.error))

    const readsBeforeForgery = nativeReads
    for (const args of [
      { op: 'create', path: 'new.txt', text: 'Forged job' },
      { op: 'read', path: '..\\outside/private.txt' },
      { op: 'read', path: 'hello.txt:stream' },
      { op: 'read', path: ['hello.txt'] },
      null,
    ]) {
      intercept = (body, reply) => {
        if (body.action === 'poll' && reply.job) return { ...reply, job: { ...reply.job, args } }
        return reply
      }
      await expectError(tool('read', 'hello.txt'), 'invalid-request')
    }
    intercept = null
    assert.equal(nativeReads, readsBeforeForgery)
    assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), hello)
    assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'Private')
    await assert.rejects(readFile(path.join(root, 'new.txt')), { code: 'ENOENT' })

    intercept = (body, reply) => body.action === 'poll' && reply.job
      ? { ...reply, job: { ...reply.job, sessionId: chatB } } : reply
    await expectError(tool('read', 'hello.txt'), 'offline')
    intercept = null
    assert.equal(nativeReads, readsBeforeForgery)
    await startSharing()

    intercept = (body, reply) => {
      if (body.action === 'poll' && reply.job) sessions.set(runtimeA, '20261106_rotated_chat_a')
      return reply
    }
    await expectError(tool('read', 'hello.txt'), 'offline')
    intercept = null
    assert.equal(nativeReads, readsBeforeForgery)
    sessions.set(runtimeA, chatA)
    await startSharing()

    await openChat(runtimeB, chatB)
    await startSharing()
    assert.equal((await grants()).length, 1)
    assert.deepEqual(await Promise.all([
      tool('read', 'hello.txt'), tool('read', 'hello.txt', undefined, chatB),
    ]), [readExpected, readExpected])
    await call('expire', {}, 'primary', chatB)
    await expectError(tool('read', 'hello.txt', undefined, chatB), 'offline')
    assert.deepEqual(await tool('read', 'hello.txt'), readExpected)
    await until(() => find(panel(), node => node.type === 'button' &&
      node.children[0] === 'Start sharing' && !node.props.disabled))
    await button('Start sharing').props.onClick()

    await openChat(runtimeA, chatA)
    button('Stop sharing').props.onClick()
    assert.deepEqual(await stopReply, { ok: true })
    await expectError(api('poll', desktopKeys.get(chatA)), 'share-ended')
    await expectError(tool('read', 'hello.txt'), 'offline')
    assert.deepEqual(await tool('read', 'hello.txt', undefined, chatB), readExpected)
    await call('expire', {}, 'primary', chatB)
    await expectError(tool('read', 'hello.txt', undefined, chatB), 'offline')
    assert.equal((await grants()).length, 1)

    await startSharing()
    assert.deepEqual(await tool('read', 'hello.txt'), readExpected)
    gateway.set('closed')
    assert.match(status(), /gateway or profile changed/)
    // Do not poll the broker directly with the owner's key. That would renew the share.
    await delay(await call('heartbeatMs', {}) + 250)
    await expectError(tool('read', 'hello.txt'), 'offline')
    await expectError(api('poll', desktopKeys.get(chatA)), 'share-ended')
    gateway.set('open')
    await expectError(tool('read', 'hello.txt'), 'offline')

    await openChat(runtimeA, chatA)
    await startSharing()
    const readsBeforeSwitch = nativeReads
    const finishesBeforeSwitch = finished
    intercept = (body, reply) => {
      if (body.action === 'poll' && reply.job) {
        epoch++
        profile.set('other')
      }
      return reply
    }
    const interrupted = tool('read', 'hello.txt')
    await until(() => profile.get() === 'other')
    assert.match(status(), /profile changed/)
    await call('expire', {})
    await expectError(interrupted, 'offline')
    assert.equal(nativeReads, readsBeforeSwitch)
    assert.equal(finished, finishesBeforeSwitch)
    intercept = null
    profile.set('primary')

    await openChat(runtimeA, chatA)
    await startSharing()
    const [grant] = await grants()
    const finishesBeforeRevoke = finished
    const { promise: readCompleted, resolve: completeRead } = Promise.withResolvers()
    const { promise: releaseRead, resolve: resumeRead } = Promise.withResolvers()
    readReply = result => {
      completeRead(result)
      return releaseRead.then(() => result)
    }
    const revokedRead = tool('read', 'hello.txt')
    try {
      const result = await Promise.race([readCompleted, revokedRead])
      assert.equal(result.ok, true)
      assert.equal(result.text, hello)
      await native.revoke(plugin.id, grant.id)
    } finally {
      resumeRead()
      readReply = null
    }
    await until(() => /revoked/.test(status()))
    await expectError(revokedRead, 'offline')
    assert.equal(finished, finishesBeforeRevoke)
    await expectError(tool('list', '.'), 'offline')

    assert.deepEqual(await grants(), [])
    assert.equal(mutationCalls, 0)
    assert.deepEqual(await outsideSnapshot(), outsideBefore)

    reviewedWrites = []
    const reviewPath = 'review.txt'
    const original = '\uFEFFবাংলা ☕\r\nOriginal\r\n'
    const replacement = '\uFEFFবাংলা ☕\r\nApproved\r\n'
    const reviewFile = path.join(root, reviewPath)
    await writeFile(reviewFile, original)
    const agent = (body, sessionId = chatA) => call('tool', body, 'primary', sessionId)
    const proposalStatus = (proposalId, sessionId = chatA) => agent({ op: 'status', proposalId }, sessionId)
    const checkStatus = async (proposalId, expected) => {
      await until(async () => (await proposalStatus(proposalId)).status === expected)
    }
    const expectBytes = async (file, text) => assert.deepEqual(await readFile(file), Buffer.from(text))
    const visibleButton = label => find(panel(), node => node.type === 'button' && node.children[0] === label)
    const reviewButton = label => until(() => {
      const control = visibleButton(label)
      return control && !control.props.disabled ? control : undefined
    })
    const permissionControl = label => {
      const control = find(panel(), node => node.type === 'label' && node.children.includes(label))
      const input = find(control, node => node.type === 'input' && node.props.type === 'checkbox')
      assert(input, 'Missing permission control ' + label)
      return input
    }
    const enable = label => {
      const input = permissionControl(label)
      if (!input.props.checked) input.props.onChange({ target: { checked: true }, currentTarget: { checked: true } })
    }
    async function startReviewSharing() {
      await button('Choose folder').props.onClick()
      enable('Update existing files')
      enable('Create new files')
      await button('Start sharing').props.onClick()
    }
    async function propose(body) {
      const result = await agent(body)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.status, 'pending')
      assert.match(result.proposalId, /^[a-f0-9]{32}$/)
      return result.proposalId
    }
    const create = (relative, text) => propose({ op: 'propose_create', path: relative, text })
    const update = (baseVersion, text) => propose({ op: 'propose_update', path: reviewPath, baseVersion, text })
    const readBase = async expected => {
      const result = await tool('read', reviewPath)
      assert.equal(result.ok, true)
      assert.equal(result.text, expected)
      assert.match(result.baseVersion, /^[a-f0-9]{64}$/)
      return result.baseVersion
    }

    const accessArgs = {
      op: 'request_access', permissions: ['read', 'update', 'create'], durationSeconds: 300,
      folderHint: root,
    }
    let accessRequest = await agent(accessArgs)
    assert.equal(accessRequest.ok, true, JSON.stringify(accessRequest))
    assert.equal(accessRequest.directive, '::drawbridge-access{id="' + accessRequest.requestId + '"}')
    const renderAccess = contributions.get('access-request-card').data.render
    assert.equal(renderAccess({ attrs: { id: 'invalid' }, sessionId: chatA }), null)
    assert.equal(renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA, streaming: true }), null)
    assert.deepEqual(renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA }).props, {
      requestId: accessRequest.requestId, sessionId: chatA,
    })
    await expectError(tool('read', reviewPath), 'offline')
    const beforePanelLookup = accessLookups
    await openChat(runtimeA, chatA)
    await until(() => accessLookups > beforePanelLookup)
    const beforeCardLookup = accessLookups
    const mountedCard = renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA })
    globalThis.drawbridgeCardEffects = []
    mountedCard.type(mountedCard.props)
    mountedCard.type(mountedCard.props)
    const mountEffects = globalThis.drawbridgeCardEffects
    delete globalThis.drawbridgeCardEffects
    for (const effect of mountEffects) effect()
    await until(() => find(mountedCard.type(mountedCard.props), node =>
      node.type === 'button' && node.children[0] === 'Confirm folder'))
    assert.equal(accessLookups, beforeCardLookup + 1)
    for (const effect of mountEffects) effect()
    assert.equal(accessLookups, beforeCardLookup + 1)
    function requestButton(label) {
      const accessCard = renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA })
      return find(accessCard.type(accessCard.props), node => node.type === 'button' && node.children[0] === label)
    }
    cancelPicker = true
    await requestButton('Confirm folder').props.onClick()
    cancelPicker = false
    assert.deepEqual(await grants(), [])
    assert.equal((await api('access_request', undefined, { sessionId: chatA })).request.id, accessRequest.requestId)
    disconnectDuringPick = true
    await requestButton('Confirm folder').props.onClick()
    disconnectDuringPick = false
    gateway.set('open')
    await expectError(tool('read', reviewPath), 'offline')
    pickerPath = outside
    await requestButton('Confirm folder').props.onClick()
    pickerPath = undefined
    assert.equal(button('Share and continue').props.disabled, false)
    assert.match(status(), /You chose a different folder/)
    assert(find(panel(), node => node.type === 'ol' && node.props?.['aria-label'] === 'Folder path' &&
      find(node, child => child.type === 'span' && child.children[0] === 'outside')))
    await expectError(tool('read', reviewPath), 'offline')
    for (const grant of await grants()) await native.revoke(plugin.id, grant.id)
    await expectError(api('reject_access', undefined, { sessionId: chatB, id: accessRequest.requestId }), 'request-ended')
    const continuation = []
    globalThis.drawbridgeSdkFixture.openSession = async (id, { profile }) => {
      continuation.push({ id, profile })
    }
    globalThis.drawbridgeSdkFixture.composer = {
      submit: (id, text) => {
        continuation.push({ id, text })
        return true
      },
    }
    await requestButton('Confirm folder').props.onClick()
    assert.equal(startBodies.get(chatA).requestId, accessRequest.requestId)
    assert.equal(startBodies.get(chatA).durationSeconds, 300)
    assert.deepEqual(startBodies.get(chatA).permissions, ['read', 'update', 'create'])
    assert.equal(continuation[0]?.id, chatA)
    assert.equal(continuation.length, 1)
    assert.equal((await api('access_request', undefined, { sessionId: chatA })).request, null)
    await button('Stop sharing').props.onClick()
    continuation.length = 0
    accessRequest = await agent({ ...accessArgs, permissions: ['read'] })
    const savedDuration = storage.get('durationSeconds')
    const approvableCard = renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA })
    globalThis.drawbridgeCardEffects = []
    approvableCard.type(approvableCard.props)
    for (const effect of globalThis.drawbridgeCardEffects) effect()
    delete globalThis.drawbridgeCardEffects
    await until(() => requestButton('Approve and continue'))
    assert(find(approvableCard.type(approvableCard.props),
      node => node.type === 'ol' && node.props?.['aria-label'] === 'Folder path'))
    await expectError(tool('read', reviewPath), 'offline')
    await requestButton('Approve and continue').props.onClick()
    assert.deepEqual(continuation, [
      { id: chatA, text: 'I granted Drawbridge folder access. Continue the task that requested access, using the permissions I granted.' },
    ])
    assert.equal(startBodies.get(chatA).requestId, accessRequest.requestId)
    assert.equal(startBodies.get(chatA).durationSeconds, 300)
    assert.deepEqual(startBodies.get(chatA).permissions, ['read'])
    assert.equal(storage.get('durationSeconds'), savedDuration)

    const readOnlyToken = desktopKeys.get(chatA)
    accessRequest = await agent(accessArgs)
    const upgradeCard = renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA })
    globalThis.drawbridgeCardEffects = []
    upgradeCard.type(upgradeCard.props)
    for (const effect of globalThis.drawbridgeCardEffects) effect()
    delete globalThis.drawbridgeCardEffects
    await until(() => requestButton('Approve upgrade and continue'))
    await expectError(api('start', 'f'.repeat(64), {
      ...startBodies.get(chatA), token: 'f'.repeat(64), requestId: accessRequest.requestId,
      permissions: accessArgs.permissions, replaceToken: '0'.repeat(64),
    }), 'share-ended')
    assert.equal((await tool('read', reviewPath)).ok, true)
    await requestButton('Approve upgrade and continue').props.onClick()
    assert.deepEqual(startBodies.get(chatA).permissions, ['read', 'update', 'create'])
    await expectError(api('poll', readOnlyToken), 'share-ended')
    assert.equal(continuation.length, 2)

    accessRequest = await agent(accessArgs)
    const overlappingCard = renderAccess({ attrs: { id: accessRequest.requestId }, sessionId: chatA })
    globalThis.drawbridgeCardEffects = []
    overlappingCard.type(overlappingCard.props)
    for (const effect of globalThis.drawbridgeCardEffects) effect()
    delete globalThis.drawbridgeCardEffects
    await until(() => requestButton('Review folder access'))
    assert(find(overlappingCard.type(overlappingCard.props), node =>
      node.type === 'p' && /^This chat already has a share\./.test(node.children[0])))
    assert.equal(requestButton('Approve and continue'), undefined)
    await requestButton('Reject').props.onClick()

    const version = await readBase(original)
    const approved = await update(version, replacement)
    await expectBytes(reviewFile, original)
    assert.equal(reviewedWrites.length, 0)
    const review = find(panel(), node => node.type === 'pre')
    assert.match(review?.children[0] ?? '', /Original\\r\\n/)
    assert.match(review.children[0], /Approved\\r\\n/)
    assert.match(review.children[0], /\\u\{feff\}/i)
    const applyFromA = (await reviewButton('Apply once')).props.onClick
    await openChat(runtimeB, chatB)
    assert.equal(visibleButton('Apply once'), undefined)
    await expectError(proposalStatus(approved, chatB), 'proposal-ended')
    await applyFromA()
    await checkStatus(approved, 'pending')
    assert.equal(reviewedWrites.length, 0)
    await openChat(runtimeA, chatA)
    const apply = (await reviewButton('Apply once')).props.onClick
    await Promise.all([apply(), apply()])
    await checkStatus(approved, 'applied')
    await expectBytes(reviewFile, replacement)
    assert.deepEqual(reviewedWrites, [{ relative: reviewPath, text: replacement }])
    const nextVersion = await readBase(replacement)
    assert.notEqual(nextVersion, version)

    const rejected = await update(nextVersion, 'Rejected')
    await (await reviewButton('Reject')).props.onClick()
    await checkStatus(rejected, 'rejected')
    await expectBytes(reviewFile, replacement)
    assert.equal(reviewedWrites.length, 1)

    const stale = await update(nextVersion, 'Stale')
    await writeFile(reviewFile, 'External edit')
    await (await reviewButton('Apply once')).props.onClick()
    await checkStatus(stale, 'conflict')
    await expectBytes(reviewFile, 'External edit')
    await expectError(agent({
      op: 'propose_update', path: reviewPath, baseVersion: nextVersion, text: 'Stale again',
    }), 'conflict')
    assert.equal(reviewedWrites.length, 1)

    const collision = await create('collision.txt', 'Reviewed creation')
    const collisionFile = path.join(root, 'collision.txt')
    await assert.rejects(readFile(collisionFile), { code: 'ENOENT' })
    await writeFile(collisionFile, 'External creation')
    await (await reviewButton('Apply once')).props.onClick()
    await checkStatus(collision, 'conflict')
    await expectBytes(collisionFile, 'External creation')
    assert.deepEqual(reviewedWrites[1], { relative: 'collision.txt', text: 'Reviewed creation', exclusive: true })

    const uncertain = await create('uncertain.txt', replacement)
    const applyUncertain = (await reviewButton('Apply once')).props.onClick
    loseWriteReply = true
    await applyUncertain()
    loseWriteReply = false
    await checkStatus(uncertain, 'uncertain')
    await applyUncertain()
    await expectBytes(path.join(root, 'uncertain.txt'), replacement)
    assert.equal(reviewedWrites.length, 3)

    const expired = await create('expired.txt', 'Expired')
    const applyExpired = (await reviewButton('Apply once')).props.onClick
    await call('expire', {})
    await applyExpired()
    await checkStatus(expired, 'expired')
    await assert.rejects(readFile(path.join(root, 'expired.txt')), { code: 'ENOENT' })
    await until(() => {
      const start = visibleButton('Start sharing')
      return start && !start.props.disabled
    })
    await startReviewSharing()
    const revoked = await create('revoked.txt', 'Revoked')
    const applyRevoked = (await reviewButton('Apply once')).props.onClick
    await button('Change access').props.onClick()
    await applyRevoked()
    await checkStatus(revoked, 'revoked')
    await assert.rejects(readFile(path.join(root, 'revoked.txt')), { code: 'ENOENT' })
    assert.equal(reviewedWrites.length, 3)

    await startReviewSharing()
    const disconnected = await create('disconnected.txt', replacement)
    const applyDisconnected = (await reviewButton('Apply once')).props.onClick
    loseWriteReply = true
    disconnectDuringWrite = true
    await applyDisconnected()
    loseWriteReply = false
    disconnectDuringWrite = false
    await checkStatus(disconnected, 'applying')
    await call('expireApply', { proposalId: disconnected })
    await checkStatus(disconnected, 'uncertain')
    epoch++
    gateway.set('open')
    await openChat(runtimeA, chatA)
    assert(find(panel(), node => node.props?.['aria-live'] === 'polite' &&
      /Save outcome uncertain/.test(node.children[0])))
    await applyDisconnected()
    await expectBytes(path.join(root, 'disconnected.txt'), replacement)
    assert.equal(reviewedWrites.length, 4)
    await call('expire', {})
    await startReviewSharing()
    assert.match(status(), /Sharing with/)
    const nativeArgs = { op: 'propose_create', path: 'native-approved.txt', text: 'Native approval' }
    const nativeHook = (hook, params, sessionId = chatA) => call('approvalHook', { hook, params }, 'primary', sessionId)
    const nativeTurn = { turn_id: 'turn-1', tool_call_id: 'call-1' }
    const nativeApproval = await nativeHook('pre_tool_call', { ...nativeTurn, tool_name: 'drawbridge_folder', args: nativeArgs })
    assert.equal(nativeApproval.action, 'approve', JSON.stringify(nativeApproval))
    assert.equal(nativeApproval.allow_permanent, false)
    assert.match(nativeApproval.message, /Create "native-approved\.txt"/)
    assert.match(nativeApproval.message, /\+ "Native approval"/)
    assert.match(nativeApproval.message, /Click Run to approve this edit only\./)
    assert.match(nativeApproval.message, /choose Allow this session from the approval options\./)
    assert.match(nativeApproval.message, /Click Reject to leave the file unchanged\./)
    assert.match(nativeApproval.message, /Drawbridge does not support permanent approval\./)
    const nativeDecision = {
      ...nativeTurn, pattern_key: 'plugin_rule:' + nativeApproval.rule_key,
      description: nativeApproval.message, choice: 'once', surface: 'gateway',
    }
    await expectError(call('nativeTool', nativeArgs), 'approval-required')
    await nativeHook('post_approval_response', nativeDecision, chatB)
    await expectError(call('nativeTool', nativeArgs), 'approval-required')
    await assert.rejects(readFile(path.join(root, nativeArgs.path)), { code: 'ENOENT' })
    assert.equal(visibleButton('Apply once'), undefined)
    await nativeHook('post_approval_response', nativeDecision)
    await nativeHook('post_approval_response', nativeDecision)
    const nativeResult = await call('nativeTool', nativeArgs)
    assert.equal(nativeResult.status, 'applied')
    await expectBytes(path.join(root, nativeArgs.path), nativeArgs.text)
    assert.equal(reviewedWrites.length, 5)

    const deniedArgs = { ...nativeArgs, path: 'native-denied.txt' }
    const deniedTurn = { ...nativeTurn, tool_call_id: 'call-2' }
    const denied = await nativeHook('pre_tool_call', { ...deniedTurn, tool_name: 'drawbridge_folder', args: deniedArgs })
    assert.equal(denied.action, 'approve')
    await nativeHook('post_approval_response', {
      ...deniedTurn, pattern_key: 'plugin_rule:' + denied.rule_key,
      description: denied.message, choice: 'deny', surface: 'gateway',
    })
    await checkStatus(denied.rule_key.split(':')[1], 'rejected')
    await assert.rejects(readFile(path.join(root, deniedArgs.path)), { code: 'ENOENT' })

    const redactedArgs = { ...nativeArgs, path: 'native-redacted.txt' }
    const redactedTurn = { ...nativeTurn, tool_call_id: 'call-redacted' }
    const redacted = await nativeHook('pre_tool_call', {
      ...redactedTurn, tool_name: 'drawbridge_folder', args: redactedArgs,
    })
    assert.equal(redacted.action, 'approve')
    await nativeHook('post_approval_response', {
      ...redactedTurn, pattern_key: 'plugin_rule:' + redacted.rule_key,
      description: redacted.message.replace('Native approval', '[REDACTED]'), choice: 'session', surface: 'gateway',
    })
    await checkStatus(redacted.rule_key.split(':')[1], 'rejected')
    await expectError(call('nativeTool', redactedArgs), 'approval-required')
    await assert.rejects(readFile(path.join(root, redactedArgs.path)), { code: 'ENOENT' })

    const sessionArgs = { ...nativeArgs, path: 'session-approved.txt' }
    const sessionTurn = { ...nativeTurn, tool_call_id: 'call-3' }
    const sessionPrompt = await nativeHook('pre_tool_call', {
      ...sessionTurn, tool_name: 'drawbridge_folder', args: sessionArgs,
    })
    assert.equal(sessionPrompt.action, 'approve')
    await nativeHook('post_approval_response', {
      ...sessionTurn, pattern_key: 'plugin_rule:' + sessionPrompt.rule_key,
      description: sessionPrompt.message, choice: 'session', surface: 'gateway',
    })
    assert.equal((await call('nativeTool', sessionArgs)).status, 'applied')
    await expectBytes(path.join(root, sessionArgs.path), sessionArgs.text)
    const followUp = { ...nativeArgs, path: 'session-follow-up.txt' }
    assert.equal(await nativeHook('pre_tool_call', {
      ...nativeTurn, tool_call_id: 'call-4', tool_name: 'drawbridge_folder', args: followUp,
    }), null)
    await assert.rejects(readFile(path.join(root, followUp.path)), { code: 'ENOENT' })
    await expectError(call('nativeTool', followUp, 'primary', chatB), 'approval-required')
    assert.equal((await call('nativeTool', followUp)).status, 'applied')
    await expectBytes(path.join(root, followUp.path), followUp.text)
    await expectError(api('start', 'a'.repeat(64), {
      sessionId: chatA, durationSeconds: 60, folder: 'second-folder',
    }), 'already-sharing')
    assert.equal((await agent({ op: 'list_folders' })).folders.length, 1)
    await button('Stop sharing').props.onClick()
    await startReviewSharing()
    const readLimitText = 'a'.repeat(96 * 1024)
    await writeFile(path.join(root, 'large-read.txt'), readLimitText)
    const largeRead = await tool('read', 'large-read.txt')
    assert.equal(largeRead.ok, true)
    assert.equal(largeRead.text, readLimitText)
    assert.match(largeRead.baseVersion, /^[a-f0-9]{64}$/)
    await writeFile(path.join(root, 'large-read.txt'), readLimitText + 'a')
    await expectError(tool('read', 'large-read.txt'), 'too-large')
    await writeFile(path.join(root, 'large-read.txt'), '\x01'.repeat(96 * 1024))
    await expectError(tool('read', 'large-read.txt'), 'result-too-large')
    assert.match(status(), /Sharing with/)
    const largePath = 'large-edit.txt'
    await writeFile(path.join(root, largePath), 'a'.repeat(64 * 1024))
    const largeBase = await tool('read', largePath)
    assert.match(largeBase.baseVersion, /^[a-f0-9]{64}$/)
    const largeEdit = {
      op: 'propose_update', path: largePath, baseVersion: largeBase.baseVersion, text: 'b'.repeat(64 * 1024),
    }
    const largeTurn = { ...nativeTurn, tool_call_id: 'call-large' }
    const largePrompt = await nativeHook('pre_tool_call', {
      ...largeTurn, tool_name: 'drawbridge_folder', args: largeEdit,
    })
    assert.equal(largePrompt.action, 'approve', largePrompt.message)
    await nativeHook('post_approval_response', {
      ...largeTurn, pattern_key: 'plugin_rule:' + largePrompt.rule_key,
      description: largePrompt.message, choice: 'once', surface: 'gateway',
    })
    assert.equal((await call('nativeTool', largeEdit)).status, 'applied')
    await expectBytes(path.join(root, largePath), largeEdit.text)
    const newShare = await nativeHook('pre_tool_call', {
      ...nativeTurn, tool_call_id: 'call-5', tool_name: 'drawbridge_folder',
      args: { ...nativeArgs, path: 'new-share.txt' },
    })
    assert.equal(newShare.action, 'approve')
    await assert.rejects(readFile(path.join(root, 'new-share.txt')), { code: 'ENOENT' })
    await button('Stop sharing').props.onClick()
    const settingInput = label => {
      const row = find(panel(), node => node.type === 'label' && node.children[0]?.startsWith?.(label))
      return find(row, node => node.type === 'input' && node.props.type === 'number')
    }
    const setting = (label, valueAsNumber) => settingInput(label).props.onBlur({ currentTarget: { valueAsNumber } })
    const configPath = path.join(fixture, 'primary', 'config.yaml')
    await writeFile(configPath, JSON.stringify({
      plugins: { entries: { 'hermes-drawbridge': { settings: {
        max_read_kib: 48, max_reviewed_write_kib: 32, max_session_write_kib: 96,
      } } } },
    }))
    await openChat(runtimeB, chatB)
    setting('Maximum read size', 24)
    setting('Maximum reviewed write size', 48)
    setting('Maximum session-approved write size', 112)
    await startReviewSharing()
    assert.equal(settingInput('Maximum read size').props.defaultValue, 24)
    assert.equal(settingInput('Maximum reviewed write size').props.defaultValue, 32)
    assert.equal(settingInput('Maximum session-approved write size').props.defaultValue, 96)
    await writeFile(path.join(root, 'limited-read.txt'), 'a'.repeat(24 * 1024 + 1))
    await expectError(tool('read', 'limited-read.txt', undefined, chatB), 'too-large')
    const sessionLargeArgs = { ...nativeArgs, path: 'session-large.txt', text: 'x'.repeat(96 * 1024) }
    const prepareWrite = (args, callId) => nativeHook('pre_tool_call', {
      ...nativeTurn, tool_call_id: callId, tool_name: 'drawbridge_folder', args,
    }, chatB)
    assert.match((await prepareWrite(sessionLargeArgs, 'over-reviewed')).message, /too-large/)
    const smallArgs = { ...nativeArgs, path: 'session-grant.txt', text: 'x'.repeat(32 * 1024) }
    const grantPrompt = await prepareWrite(smallArgs, 'size-session-grant')
    assert.equal(grantPrompt.action, 'approve', grantPrompt.message)
    await nativeHook('post_approval_response', {
      ...nativeTurn, tool_call_id: 'size-session-grant', pattern_key: 'plugin_rule:' + grantPrompt.rule_key,
      description: grantPrompt.message, choice: 'session', surface: 'gateway',
    }, chatB)
    assert.equal((await call('nativeTool', smallArgs, 'primary', chatB)).status, 'applied')
    assert.match((await prepareWrite({ ...sessionLargeArgs, text: sessionLargeArgs.text + 'x' },
      'over-session')).message, /too-large/)
    assert.equal(await prepareWrite(sessionLargeArgs, 'within-session'), null)
    assert.equal((await call('nativeTool', sessionLargeArgs, 'primary', chatB)).status, 'applied')
    await expectBytes(path.join(root, sessionLargeArgs.path), sessionLargeArgs.text)
    await button('Stop sharing').props.onClick()
    await startReviewSharing()
    assert.match((await prepareWrite({ ...sessionLargeArgs, path: 'new-share-large.txt' },
      'new-share-over-reviewed')).message, /too-large/)
    await button('Stop sharing').props.onClick()
    await unlink(configPath)
    sessions.delete(runtimeA)
    sessions.set(chatA, chatA)
    await openChat(chatA, chatA)
    sessions.delete(chatA)
    sessions.set(runtimeA, chatA)
    await openChat(runtimeA, chatA)
    setting('Heartbeat timeout', 15)
    setting('Poll interval', 1500)
    setting('Poll interval', 15000)
    assert.equal(storage.get('pollIntervalMs'), 1500)
    scheduledDelays.clear()
    setting('Connection retries', 4)
    await startSharing()
    await until(() => scheduledDelays.has(1500))
    assert.match(status(), /No time limit/)
    assert.equal(startBodies.get(chatA).durationSeconds, 0)
    assert.equal(startBodies.get(chatA).heartbeatSeconds, 15)
    assert.equal(storage.get('retries'), 4)
    epoch++
    profile.set('other')
    assert.equal(contributions.get('sharing-indicator').render().type(), null)
    await call('expire', {})
    await expectError(tool('read', 'hello.txt'), 'offline')
    await openChat(runtimeB, chatB)
    setting('Heartbeat timeout', 5)
    assert.equal(storage.get('pollIntervalMs'), 800)
    setting('Share duration', 47)
    await startSharing()
    assert.equal(startBodies.get(chatB).durationSeconds, 47)
    await expectError(tool('read', 'hello.txt'), 'offline')
    assert.deepEqual(await call('tool', { op: 'read', path: 'hello.txt' }, 'other', chatB), readExpected)
    await expectError(call('tool', { op: 'read', path: 'hello.txt' }, 'other', chatA), 'offline')
    const chatPage = pagePath
    globalThis.drawbridgeSdkFixture.navigate(contributions.get('nav').data.path)
    const activeShares = find(panel(), node => node.props?.['aria-label'] === 'Active shares')
    assert.equal(find(activeShares, node => node.type === 'h3' && node.children[0] === 'No active shares'), undefined)
    const rows = find(activeShares, node => node.type === 'tbody').children
    assert.deepEqual(rows.map(row => row.children[0].children[0]), [chatB])
    globalThis.drawbridgeSdkFixture.navigate(chatPage)
    await button('Stop sharing').props.onClick()
    await expectError(call('tool', { op: 'read', path: 'hello.txt' }, 'other', chatB), 'offline')
    await expectError(tool('read', 'hello.txt'), 'offline')
    button('Reset to defaults').props.onClick()
    assert.equal(settingInput('Share duration').props.defaultValue, 0)
    assert.equal(settingInput('Heartbeat timeout').props.defaultValue, 8)
    assert.equal(settingInput('Poll interval').props.defaultValue, 800)
    assert.equal(settingInput('Connection retries').props.defaultValue, 3)
    assert.equal(settingInput('Maximum read size').props.defaultValue, 96)
    assert.equal(settingInput('Maximum reviewed write size').props.defaultValue, 64)
    assert.equal(settingInput('Maximum session-approved write size').props.defaultValue, 128)
    for (const key of ['durationSeconds', 'heartbeatSeconds', 'pollIntervalMs', 'retries',
      'readLimitKiB', 'reviewedWriteLimitKiB', 'sessionWriteLimitKiB']) {
      assert.equal(storage.has(key), false)
    }
    await startSharing()
    connectionId.set('another-gateway')
    assert.equal(contributions.get('sharing-indicator').render().type(), null)
    await call('expire', {})
    await expectError(tool('read', 'hello.txt'), 'offline')
    await call('expire', {}, 'other', chatB)
    await expectError(call('tool', { op: 'read', path: 'hello.txt' }, 'other', chatB), 'offline')
    assert.equal(mutationCalls, 0)
    assert.deepEqual(await outsideSnapshot(), outsideBefore)
    console.log('Passed Drawbridge smoke checks against the native Hermes file API on ' + process.platform)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
} finally {
  loader.deregister()
  broker.stdin.end()
  await exited
  if (escapeCreated) await unlink(escape)
  await rm(fixture, { recursive: true, force: true })
}
