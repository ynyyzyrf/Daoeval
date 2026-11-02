import assert from 'node:assert/strict'
import { parseRoute } from '../web/src/lib/router.ts'

assert.deepEqual(parseRoute('/models'), { name: 'models' })
assert.deepEqual(parseRoute('/models/'), { name: 'models' })
assert.deepEqual(parseRoute('#/models'), { name: 'models' })
assert.deepEqual(parseRoute('/settings'), { name: 'settings' })
console.log('PASS model management route and settings remain distinct')
