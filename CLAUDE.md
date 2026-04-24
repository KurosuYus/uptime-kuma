# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Uptime Kuma is a self-hosted monitoring tool built with Vue 3 (frontend) and Node.js/Express (backend), using Socket.IO for real-time communication. The application monitors HTTP(s), TCP, DNS, Docker containers, and more.

## Development Setup

### Prerequisites
- Node.js >= 20.4.0
- npm >= 9.3
- Git

### Initial Setup
```bash
npm ci  # Use npm ci, NOT npm install (takes 60-90 seconds)
```

### Development Workflow
```bash
npm run dev  # Starts both frontend (port 3000) and backend (port 3001)
```

The dev command runs both servers concurrently:
- Frontend: Vite dev server on port 3000
- Backend: Node.js server on port 3001

### Building
```bash
npm run build  # Builds frontend to dist/ (takes 90-120 seconds)
```

### Linting (Required Before Commits)
```bash
npm run lint              # Run all linters
npm run lint:prod         # Production linting (zero warnings allowed)
npm run lint-fix:js       # Auto-fix JavaScript/Vue issues
npm run lint-fix:style    # Auto-fix style issues
```

### Testing
```bash
npm run test-backend      # Backend tests only (~50-60 seconds)
npm run test-e2e          # Playwright E2E tests
npm test                  # All tests
```

Note: Always run `npm run build` before running tests.

## Architecture

### Communication Pattern
The application primarily uses **Socket.IO** for client-server communication, not REST APIs. Most backend logic is in socket event handlers, not Express routes.

### Directory Structure

**Backend (`server/`)**
- `server.js` - Main entry point (DO NOT require this in other modules - causes circular dependencies)
- `uptime-kuma-server.js` - Core server class (singleton pattern via `UptimeKumaServer.getInstance()`)
- `socket-handlers/` - Socket.IO event handlers (main backend logic)
  - `general-socket-handler.js` - General operations
  - `database-socket-handler.js` - Database operations
  - `status-page-socket-handler.js` - Status page operations
  - `maintenance-socket-handler.js` - Maintenance windows
  - `docker-socket-handler.js` - Docker monitoring
  - `proxy-socket-handler.js` - Proxy configuration
  - `api-key-socket-handler.js` - API key management
  - `chart-socket-handler.js` - Chart data
  - `cloudflared-socket-handler.js` - Cloudflare tunnel
  - `remote-browser-socket-handler.js` - Browser automation
- `monitor-types/` - Monitor type implementations (extend `MonitorType` base class)
- `notification-providers/` - Notification integrations (90+ providers)
- `model/` - Database models (auto-mapped to SQLite tables using Redbean-node ORM)
- `routers/` - Express REST routes (minimal, mostly for status pages and API)
- `database.js` - Database initialization and migrations
- `notification.js` - Notification provider registry

**Frontend (`src/`)**
- `main.js` - Vue 3 app entry point
- `App.vue` - Root component
- `router.js` - Vue Router configuration
- `pages/` - Page components
- `components/` - Reusable Vue components
  - `notifications/` - Notification provider UI components
- `lang/` - i18n translations (managed via Weblate)
- `mixins/` - Vue mixins
- `util.js`, `util.ts` - Shared utilities

**Database (`db/`)**
- `knex_migrations/` - Knex.js migration files
- `kuma.db` - SQLite database (gitignored)

**Configuration (`config/`)**
- `vite.config.js` - Vite build configuration
- `playwright.config.js` - E2E test configuration

**Other**
- `extra/` - Utility scripts (release, password reset, etc.)
- `docker/` - Docker build files
- `test/backend-test/` - Backend unit tests
- `test/e2e/` - Playwright E2E tests

### Monitor Types System

Monitor types are registered in `uptime-kuma-server.js` constructor:
```javascript
UptimeKumaServer.monitorTypeList["dns"] = new DnsMonitorType();
UptimeKumaServer.monitorTypeList["postgres"] = new PostgresMonitorType();
// etc.
```

Each monitor type extends the `MonitorType` base class and implements monitoring logic in `server/monitor-types/`.

### Database

- **Primary**: SQLite (also supports MariaDB/MySQL)
- **ORM**: Redbean-node (accessed via `R` object)
- **Migrations**: Knex.js migrations in `db/knex_migrations/`
- **Naming**: Database uses snake_case, JavaScript uses camelCase

## Code Style (Strictly Enforced)

- **Indentation**: 4 spaces (not tabs)
- **Quotes**: Double quotes
- **Line endings**: Unix (LF)
- **Semicolons**: Required
- **Naming conventions**:
  - JavaScript/TypeScript: camelCase
  - SQLite columns: snake_case
  - CSS/SCSS: kebab-case
- **JSDoc**: Required for all functions/methods

Configuration files: `.eslintrc.js`, `.stylelintrc`, `.editorconfig`

## Adding New Features

### New Monitor Type

1. Create `server/monitor-types/YOUR_TYPE.js` extending `MonitorType`
2. Register in `server/uptime-kuma-server.js` constructor
3. Add UI in `src/pages/EditMonitor.vue`
4. Add translation keys to `src/lang/en.json` only

### New Notification Provider

1. Create `server/notification-providers/PROVIDER_NAME.js` with backend logic
   - Wrap axios calls in try-catch: `this.throwGeneralAxiosError(error)`
   - Handle `monitorJSON` and `heartbeatJSON` being null (test messages)
2. Register in `server/notification.js`
3. Create `src/components/notifications/PROVIDER_NAME.vue` for UI
4. Register in `src/components/notifications/index.js`
5. Add to list in `src/components/NotificationDialog.vue` (regional or global)
6. Add translation keys to `src/lang/en.json` only

## Translations

- Managed via Weblate - do NOT include other languages in PRs
- Add new keys to `src/lang/en.json` only
- Use `$t("key")` in Vue templates or `<i18n-t keypath="key">`

## Important Notes

- **npm ci vs npm install**: Always use `npm ci` for reproducible builds
- **TypeScript**: `npm run tsc` shows 1400+ errors - this is expected, ignore them
- **Circular dependencies**: Never require `server/server.js` in other modules
- **Singleton pattern**: Use `UptimeKumaServer.getInstance()` to access server instance
- **Port conflicts**: Dev uses ports 3000 (frontend) and 3001 (backend)
- **First run**: "db-config.json not found" is expected - starts setup wizard
- **Dependencies**: 5 known vulnerabilities are acknowledged - don't fix without discussion
- **Git branches**: `master` (v2 development), `1.23.X` (v1 maintenance)
- **Never commit**: `data/`, `dist/`, `tmp/`, `private/`, `node_modules/`

## Configuration Files

- **package.json**: Scripts, dependencies, Node.js version requirement
- **.npmrc**: `legacy-peer-deps=true` (required for dependency resolution)
- **.eslintrc.js**: ESLint rules
- **.stylelintrc**: Stylelint rules
- **.editorconfig**: Editor settings
- **tsconfig-backend.json**: TypeScript config (only for `src/util.ts`)

## CI/CD

- **auto-test.yml**: Runs on PR/push - linting, building, tests (15 min timeout)
- **validate.yml**: Validates JSON/YAML files, language files, migrations
- All linters must pass, tests must pass for PR approval

## Useful Commands

```bash
# Development
npm run start-server-dev        # Backend only
npm run start-frontend-dev      # Frontend only
npm run start-server-dev:watch  # Backend with auto-restart

# Testing
npm run test-e2e-ui            # Playwright UI mode
npm run playwright-codegen     # Generate test code

# Utilities
npm run reset-password         # Reset admin password
npm run remove-2fa            # Remove 2FA
npm run tsc                   # TypeScript check (expect errors)

# Database helpers
npm run simple-postgres       # Run PostgreSQL in Docker
npm run simple-mariadb        # Run MariaDB in Docker
npm run simple-mongo          # Run MongoDB in Docker
```
