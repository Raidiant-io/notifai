import { expect, it } from 'vitest'
import { isListProjectsResponse, isProjectView } from './api.js'

const project = {
  project_id: 'opaque/project', identifier: '', display_name: null, image_media_id: null,
  avatar_revision: 'future:revision', image_url: null, last_seen_at: 'stored date',
}

it('preserves Project nulls, opaque strings and additive fields without changing them', () => {
  const value = { ...project, display_name: '', image_media_id: 'opaque/media', image_url: '/signed/image?signature=keep',
    future: { supported: true } }
  const before = structuredClone(value)
  expect(isProjectView(project)).toBe(true)
  expect(isProjectView(value)).toBe(true)
  expect(isListProjectsResponse({ projects: [], future: true })).toBe(true)
  expect(isListProjectsResponse({ projects: [project, value], future: true })).toBe(true)
  expect(value).toEqual(before)
})

it.each(Object.keys(project))('requires the %s Project fact', key => {
  const value = Object.fromEntries(Object.entries(project).filter(([field]) => field !== key))
  expect(isProjectView(value)).toBe(false)
  expect(isListProjectsResponse({ projects: [value] })).toBe(false)
})

it.each([
  { project_id: 1 }, { identifier: null }, { display_name: false }, { image_media_id: false },
  { avatar_revision: null }, { image_url: [] }, { last_seen_at: 1 },
])('rejects a mistyped Project fact %j', fields => {
  expect(isProjectView({ ...project, ...fields })).toBe(false)
})

it.each([null, [], {}, { projects: '' }, { projects: null }, { projects: [null] }])('rejects a malformed Project list %j', body => {
  expect(isListProjectsResponse(body)).toBe(false)
})
