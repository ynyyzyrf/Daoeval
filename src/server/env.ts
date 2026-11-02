import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'

// Load before DB/crypto imports. Deployment-injected environment takes precedence.
if (existsSync('.env')) loadEnvFile('.env')
