import * as m from './lib/index.js'
console.log('export-count:', Object.keys(m).length)
console.log('filterVisible:', typeof m.filterVisible)
console.log('deprecated:', JSON.stringify(m.deprecatedActionsInMatrix()))
console.log('untraceable:', m.untraceableActions().length)
console.log('fence:', JSON.stringify(m.checkSource({headers:{host:'hub.example.com'}}, {publicAuthorities:['hub.example.com']})))
console.log('routes:', Object.keys(m.GUARD_ROUTES).length)
