import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANARY_CARD, CANARY_STEER_TEXT, SCHEMA_CHECKS, checkSchemaBundle, classifyProviderRequest, parseCodexVersion, renderSummary, startMockProvider,
} from './codex-card-canary.mjs'

/** The smallest bundle shaped like Codex 0.163.0's generated schema. */
function goodBundle() {
  const methods = ['initialize', 'thread/loaded/list', 'thread/turns/list', 'turn/steer', 'thread/queue/list', 'thread/queue/add', 'thread/queue/delete', 'thread/start']
  return {
    clientRequest: { oneOf: methods.map(method => ({ properties: { method: { enum: [method] } } })) },
    v2: { definitions: {
      InitializeParams: { required: ['clientInfo'], properties: { clientInfo: {}, capabilities: {} } },
      InitializeCapabilities: { properties: { experimentalApi: { type: 'boolean' } } },
      ThreadLoadedListResponse: { required: ['data'], properties: { data: { type: 'array', items: { type: 'string' } }, nextCursor: { type: ['string', 'null'] } } },
      ThreadTurnsListParams: { required: ['threadId'], properties: { threadId: { type: 'string' }, limit: {}, sortDirection: { anyOf: [{ $ref: '#/definitions/SortDirection' }, { type: 'null' }] }, itemsView: { anyOf: [{ $ref: '#/definitions/TurnItemsView' }, { type: 'null' }] } } },
      SortDirection: { enum: ['asc', 'desc'] },
      TurnItemsView: { oneOf: [{ enum: ['notLoaded'] }, { enum: ['summary'] }, { enum: ['full'] }] },
      ThreadTurnsListResponse: { required: ['data'], properties: { data: { type: 'array', items: { $ref: '#/definitions/Turn' } } } },
      Turn: { properties: { id: { type: 'string' }, status: { $ref: '#/definitions/TurnStatus' }, itemsView: { allOf: [{ $ref: '#/definitions/TurnItemsView' }] } } },
      TurnStatus: { enum: ['completed', 'interrupted', 'failed', 'inProgress'] },
      TurnSteerParams: { required: ['expectedTurnId', 'input', 'threadId'], properties: { input: { items: { $ref: '#/definitions/UserInput' } } } },
      UserInput: { oneOf: [{ properties: { type: { enum: ['text'] }, text: { type: 'string' } } }, { properties: { type: { enum: ['image'] } } }] },
      TurnSteerResponse: { required: ['turnId'], properties: { turnId: { type: 'string' } } },
      AsyncUserInputQuestion: { required: ['title'], properties: { title: { type: 'string' }, options: { type: ['array', 'null'], items: { type: 'string' } } } },
    } },
  }
}

test('a bundle shaped like Codex 0.163.0 passes every schema check', () => {
  const findings = checkSchemaBundle(goodBundle())
  assert.equal(findings.length, SCHEMA_CHECKS.length)
  assert.deepEqual(findings.filter(finding => !finding.ok), [])
  for (const finding of findings) assert.match(finding.guards, /\.ts/)
})

const drifts = [
  ['a removed method', bundle => { bundle.clientRequest.oneOf = bundle.clientRequest.oneOf.filter(entry => entry.properties.method.enum[0] !== 'turn/steer') }, /missing turn\/steer/],
  ['expectedTurnId no longer required', bundle => { bundle.v2.definitions.TurnSteerParams.required = ['threadId', 'input'] }, /expectedTurnId no longer required/],
  ['inProgress gone from TurnStatus', bundle => { bundle.v2.definitions.TurnStatus.enum = ['completed', 'running'] }, /no longer has inProgress/],
  // Params and Turn share TurnItemsView, so this drift trips both guards.
  ['notLoaded gone from the items view', bundle => { bundle.v2.definitions.TurnItemsView.oneOf = [{ enum: ['summary'] }] }, /notLoaded/, 2],
  ['loaded threads no longer strings', bundle => { bundle.v2.definitions.ThreadLoadedListResponse.properties.data.items = { $ref: '#/definitions/Turn' } }, /data items are not strings/],
  ['steer receipt loses turnId', bundle => { bundle.v2.definitions.TurnSteerResponse = { properties: {} } }, /turnId is not a required string/],
  ['card options become objects', bundle => { bundle.v2.definitions.AsyncUserInputQuestion.properties.options.items = { type: 'object' } }, /options are not an array of strings/],
  ['a definition disappears', bundle => { delete bundle.v2.definitions.ThreadTurnsListParams }, /definition ThreadTurnsListParams is missing/],
]
for (const [name, mutate, expected, count = 1] of drifts) {
  test(`schema drift fails the exact guard: ${name}`, () => {
    const bundle = goodBundle()
    mutate(bundle)
    const failed = checkSchemaBundle(bundle).filter(finding => !finding.ok)
    assert.equal(failed.length, count, JSON.stringify(failed))
    for (const finding of failed) assert.match(finding.detail, expected)
  })
}

test('the Codex version is read from the CLI banner', () => {
  assert.equal(parseCodexVersion('codex-cli 0.163.0\n'), '0.163.0')
  assert.equal(parseCodexVersion('codex-cli 0.164.0-alpha.3'), '0.164.0-alpha.3')
  assert.equal(parseCodexVersion('unknown'), null)
})

test('model requests are classified by the round-trip step they belong to', () => {
  assert.equal(classifyProviderRequest({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ask me.' }] }] }), 'card')
  assert.equal(classifyProviderRequest({ input: [{ type: 'function_call_output', call_id: CANARY_CARD.callId, output: '{"accepted":true}' }] }), 'after-card')
  assert.equal(classifyProviderRequest({ input: [
    { type: 'function_call_output', call_id: CANARY_CARD.callId, output: '{"accepted":true}' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: CANARY_STEER_TEXT }] },
  ] }), 'after-steer')
  assert.equal(classifyProviderRequest({ input: [{ type: 'function_call_output', call_id: 'other' }] }), 'card')
  assert.equal(classifyProviderRequest({}), 'card')
})

test('the mock provider emits the card, holds the turn until released, then finishes', async () => {
  const mock = await startMockProvider()
  try {
    const post = async body => {
      const response = await fetch(`http://127.0.0.1:${mock.port}/v1/responses`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
      assert.equal(response.headers.get('content-type'), 'text/event-stream')
      return response.text()
    }
    const first = await post({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Ask me.' }] }] })
    assert.match(first, /event: response\.output_item\.done/)
    assert.match(first, /"name":"request_user_input_async"/)
    assert.match(first, new RegExp(`"call_id":"${CANARY_CARD.callId}"`))
    assert.match(first, /event: response\.completed/)
    let settled = false
    const held = post({ input: [{ type: 'function_call_output', call_id: CANARY_CARD.callId, output: '{"accepted":true}' }] }).then(text => { settled = true; return text })
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(settled, false, 'the accepted-card request must stay open until the steer was admitted')
    mock.release()
    assert.match(await held, /Canary turn complete/)
    const steered = await post({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: CANARY_STEER_TEXT }] }] })
    assert.match(steered, /Canary turn complete/)
    assert.deepEqual(mock.requests.map(request => request.kind), ['card', 'after-card', 'after-steer'])
  } finally { await mock.close() }
})

test('the step summary names the Codex version and every failing guard', () => {
  const summary = renderSummary({ ok: false, codexVersion: '0.170.0', findings: [
    { ok: true, check: 'fine', guards: 'a.ts' },
    { ok: false, check: 'drifted', guards: 'b.ts', detail: 'turnId | gone' },
  ] })
  assert.match(summary, /RED on Codex 0\.170\.0/)
  assert.match(summary, /\| FAIL \| drifted \| `b\.ts` \| turnId \\\| gone \|/)
})
