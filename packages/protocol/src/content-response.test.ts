import { expect, it } from 'vitest'
import { Value } from '@sinclair/typebox/value'
import { isNotificationContentBatchResponse, isNotificationContentResponse, NotificationContentBatchRequest } from './api.js'
import { NotificationDraftView, Question } from './notification.js'

const question = { id: 'Older question id!', text: 'A retained question. '.repeat(20), multi: true, future: true,
  choices: [{ id: 'Older choice id!', label: 'A retained label. '.repeat(4), description: 'Explanation. '.repeat(20),
    recommended: true, future: { detail: true } }] }
const content = { request_id: 'retained/id', summary: 'Report', body: null,
  media: [{ media_id: 'image', position: 0, media_type: 'image/png', alt: null, url: null, preview_url: null,
    width: null, height: null, future: true }], questions: [question], future: { layout: 'wide' } }

it('reads retained questions consistently with the feed without applying submission policy', () => {
  expect(Value.Check(Question, question)).toBe(false)
  expect(Value.Check(NotificationDraftView.properties.reply.properties.questions, [question])).toBe(true)
  const batch = { contents: [content], missing: ['no-longer-held'], future: true }
  const before = structuredClone(batch)
  expect(isNotificationContentResponse(content)).toBe(true)
  expect(isNotificationContentBatchResponse(batch)).toBe(true)
  expect(batch).toEqual(before)
  expect(isNotificationContentBatchResponse({ contents: [], missing: [] })).toBe(true)
})

it.each([
  { body: {} }, { media: [{ ...content.media[0], position: '0' }] },
  { media: [{ ...content.media[0], media_type: 'not-an-image' }] },
  { media: [{ ...content.media[0], preview_url: false }] },
  { questions: [{ ...question, multi: 'yes' }] },
  { questions: [{ ...question, choices: [{ id: 'yes', label: 'Yes', recommended: false }] }] },
])('rejects malformed nested content in single and batch output: %j', fields => {
  const malformed = { ...content, ...fields }
  expect(isNotificationContentResponse(malformed)).toBe(false)
  expect(isNotificationContentBatchResponse({ contents: [malformed], missing: [] })).toBe(false)
})

it('leaves new batch request bounds and closure in force', () => {
  const request = { request_ids: ['req_0000000000000000000000'] }
  expect(Value.Check(NotificationContentBatchRequest, request)).toBe(true)
  expect(Value.Check(NotificationContentBatchRequest, { ...request, future: true })).toBe(false)
  expect(Value.Check(NotificationContentBatchRequest, { request_ids: [] })).toBe(false)
})

it('accepts single content from before questions were added to the read endpoint', () => {
  expect(isNotificationContentResponse({ request_id: 'retained/id', summary: 'Report', body: '## Report', media: [] })).toBe(true)
})
