# GitHub OAuth 2.0 Web Application Flow Setup Guide

**Architecture Reference:** VeriRelease Milestone 3.1  
**Target:** Verified GitHub Identity Linking & Secure Session Delivery

---

## 1. Overview

VeriRelease integrates with GitHub OAuth 2.0 to cryptographically prove that a VeriRelease user owns the GitHub username linked to their account. Browser-supplied GitHub usernames are never trusted; the username and verified primary email are obtained directly from GitHub's authoritative APIs using short-lived OAuth access tokens.

Upon successful OAuth completion, VeriRelease issues an authenticated session token delivered exclusively via a secure, `HttpOnly`, `SameSite=Lax` cookie (`vr_session`). Frontend JavaScript cannot access the session token or GitHub OAuth access tokens.

---

## 2. Registering the GitHub OAuth Application

To register an OAuth App on GitHub:

1. Log in to [GitHub](https://github.com) and navigate to **Settings** $\to$ **Developer Settings** $\to$ **OAuth Apps** $\to$ [**New OAuth App**](https://github.com/settings/applications/new).
2. Fill in the application registration form:
   - **Application name:** `VeriRelease` (or `VeriRelease Development` for local testing)
   - **Homepage URL:**
     - Production: `https://verirelease.example.com`
     - Development: `http://localhost:3000`
   - **Application description:** `AI-Assisted Milestone Verification & Payment Authorization Coordinator`
   - **Authorization callback URL:**
     - Production: `https://verirelease.example.com/api/auth/github/callback`
     - Development: `http://localhost:3000/api/auth/github/callback`
3. Click **Register application**.
4. On the application details page:
   - Note the **Client ID** (e.g. `Iv1.xxxxxxxxxxxx`).
   - Click **Generate a new client secret** and note the **Client Secret**.

> [!IMPORTANT]
> - In production (`NODE_ENV=production`), `GITHUB_OAUTH_CALLBACK_URL` **must** start with `https://`.
> - Do not reuse `GITHUB_APP_ID` as the `GITHUB_OAUTH_CLIENT_ID`.
> - Keep `GITHUB_OAUTH_CLIENT_SECRET` completely independent of `AUTH_TOKEN_SIGNING_SECRET` and `GITHUB_WEBHOOK_SECRET`.

---

## 3. Environment Variable Configuration

Add the following environment variables to your deployment environment (or `.env.local` for local development):

```bash
# GitHub OAuth 2.0 Web Application Credentials
GITHUB_OAUTH_CLIENT_ID="your_github_oauth_client_id"
GITHUB_OAUTH_CLIENT_SECRET="your_github_oauth_client_secret_min16chars"
GITHUB_OAUTH_CALLBACK_URL="https://verirelease.example.com/api/auth/github/callback"

# VeriRelease Authentication Token Signing Secret (independent of OAuth and webhook secrets)
AUTH_TOKEN_SIGNING_SECRET="your_dedicated_auth_token_signing_secret_min32chars"
```

### Environment Validation Rules (`src/lib/env.ts`)

| Environment Variable | Development Default | Production Requirement |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | Safe dev placeholder | Required; rejects placeholders (`your_`, `placeholder`) |
| `GITHUB_OAUTH_CLIENT_SECRET` | Safe dev placeholder | Required; minimum 16 characters; rejects placeholders |
| `GITHUB_OAUTH_CALLBACK_URL` | `http://localhost:3000/api/auth/github/callback` | Required; valid URL; **must use HTTPS** |
| `AUTH_TOKEN_SIGNING_SECRET` | Safe dev default | Required; minimum 32 characters; cannot match OAuth or webhook secrets |

---

## 4. Architectural Endpoints & Flow

### A. Initiation: `GET /api/auth/github/login`

- **Parameters:**
  - `action`: `"login"` (default) or `"link"`
  - `returnTo`: optional relative destination path (e.g. `/dashboard`), sanitized against open redirects
  - `format`: optional `"json"` to return `{ authorizationUrl }` for programmatic clients
- **Security Controls:**
  - If `action="link"`, caller must be authenticated; unauthenticated requests are rejected with `401 Unauthorized`.
  - Generates unpredictable 32-byte cryptographic nonce.
  - Seals state payload with HMAC-SHA256 (`vr_state.<payload>.<signature>`).
  - Sets short-lived (10-minute) `HttpOnly`, `SameSite=Lax` cookie `vr_oauth_state`.
  - Redirects user to GitHub's authorization endpoint with scopes `read:user,user:email`.

### B. Callback: `GET /api/auth/github/callback`

- **Parameters:** `code`, `state`
- **Security Controls:**
  - Constant-time comparison between request `state` and `vr_oauth_state` cookie.
  - Verifies state HMAC signature and freshness (< 10 minutes).
  - Clears `vr_oauth_state` cookie immediately (single-use token protection).
  - Exchanges authorization code for temporary access token via `POST https://github.com/login/oauth/access_token`.
  - Fetches GitHub profile (`GET https://api.github.com/user`) and verified primary email (`GET https://api.github.com/user/emails`).
  - Immediately drops GitHub access token from memory (never logged, never persisted, never returned in response).
  - Prevents claiming already-linked GitHub accounts (`DomainConflictError` and PostgreSQL unique index `uq_user_github_username_lower`).
  - Generates VeriRelease session token and delivers it exclusively in an `HttpOnly`, `Path=/`, `SameSite=Lax` cookie (`vr_session`).

### C. Session Verification: `GET /api/auth/me`

- Resolves authenticated user from either `vr_session` cookie or `Authorization: Bearer <token>` header.
- Revalidates database record (`isActive: true`, `suspendedAt: null`, `tokenVersion`).
- Returns `{ user: { id, email, name, role, githubUsername, isActive } }`.

### D. Logout: `POST /api/auth/logout`

- Clears `vr_session` cookie (`Max-Age=0`).
