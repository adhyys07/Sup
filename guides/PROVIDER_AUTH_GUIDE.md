# Multi-Provider Authentication & Account Linking

## Overview
Users can now sign up and log in using multiple authentication providers. When a user tries to register with an email that's already associated with a different provider, they'll receive a helpful error message and be guided to link their accounts instead.

## Features Implemented

### 1. **Provider Conflict Detection**

#### Registration Check
When a user attempts to sign up with email/password:
- System checks if the email already exists
- If it exists with a different provider (Google/GitHub), returns error with provider info
- User is offered option to log in with the existing provider

**Error Response (HTTP 409):**
```json
{
  "error": "This email is already registered using google. Please log in with google instead or use a different email.",
  "existingProvider": "google",
  "code": "PROVIDER_MISMATCH"
}
```

**Frontend Response:**
- Shows provider conflict message
- Displays "Log in with [Provider]" button
- Prefills email in login form

### 2. **Account Linking in Settings**

#### New Connections Tab in Profile
Located at `/profile.html` → "Manage Connections" button

**Available Providers:**
- **Email & Password** (local) - Email verification required
- **Google** - Secure OAuth login
- **GitHub** - Secure OAuth login

#### Connection Management
Each provider shows:
- Connection status (Connected/Not Connected)
- Link/Unlink buttons
- Security verification when unlinking

### 3. **Backend API Endpoints**

#### `GET /api/user/connections`
Returns all connected authentication methods for the user

**Response:**
```json
{
  "connections": {
    "local": {
      "provider": "local",
      "connected": true,
      "type": "Email & Password"
    },
    "google": {
      "provider": "google",
      "connected": true,
      "type": "Google"
    },
    "github": {
      "provider": "github",
      "connected": false,
      "type": "GitHub"
    }
  }
}
```

#### `POST /api/user/link-provider/:provider`
Initiates account linking process for Google or GitHub

**Available Providers:**
- `google`
- `github`

**Response:**
```json
{
  "redirectUrl": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

**Flow:**
1. User clicks "Connect" for a provider
2. Frontend calls this endpoint
3. Redirects to provider's OAuth flow
4. After OAuth, account is linked
5. User returned to profile page

#### `POST /api/user/unlink-provider/:provider`
Unlinks a provider from the account

**Requirements:**
- User must have at least one other login method
- Cannot unlink the last authentication method
- Requires confirmation

**Response:**
```json
{
  "message": "google account has been unlinked"
}
```

**Error Prevention:**
```json
{
  "error": "You must have at least one login method. Keep this provider or set a password first."
}
```

### 4. **Database Schema**

Fields in `users` table:
- `authProvider` (varchar) - 'local', 'google', 'github', or null
- `authProviderId` (varchar) - Provider's unique user ID
- `password` (varchar) - Hashed password (null for OAuth-only)
- `emailVerified` (boolean) - Email verification status
- `emailVerificationToken` (varchar) - Token for email verification
- `emailVerificationTokenExpires` (timestamp) - Token expiration

### 5. **Security Considerations**

#### Provider Mismatch Protection
- Email uniqueness enforced across all providers
- Users cannot accidentally create duplicate accounts
- Helpful guidance to unify accounts

#### Account Unlinking Safety
- Cannot unlink all authentication methods
- Must confirm before unlinking
- At least one method always available

#### OAuth Integration
- Uses secure OAuth 2.0 flows
- Tokens stored safely
- Automatic account unification

#### Email Verification
- Local auth requires email verification
- OAuth auto-verifies emails
- One-time token with expiration

### 6. **User Flows**

#### Sign Up with Email & Password
1. User fills signup form
2. Server checks if email exists with different provider
3. If unique or only local: Email verification sent
4. User verifies email
5. Can now log in

#### Try to Sign Up with Existing Email (Different Provider)
1. User attempts to register
2. Server detects email exists with Google/GitHub
3. Error shown: "Email registered with [Provider]"
4. User clicks "Log in with [Provider]"
5. OAuth flow completes
6. User logged in

#### Link Additional Provider
1. User goes to Profile → Manage Connections
2. Clicks "Connect" next to provider
3. OAuth popup/redirect happens
4. After auth, connection established
5. User can now login with either method

#### Unlink Provider
1. User clicks "Unlink" button
2. Confirmation dialog appears
3. Upon confirmation, provider removed
4. User can only use remaining methods

### 7. **Frontend Implementation**

#### Profile Page Updates (`profile.html`)
- New "Manage Connections" button
- Connections tab shows all auth methods
- Connect/Unlink buttons with status indicators
- Helpful messaging and confirmation dialogs

#### Login & Registration (`index.html`)
- Provider mismatch detection
- Helpful error messages with action buttons
- Auto-fill email when switching forms
- Clean UX for account linking

#### Error Handling
- User-friendly error messages
- Clear guidance on next steps
- Links to help documentation
- Status feedback during OAuth redirects

### 8. **Error Codes**

| Code | Meaning | User Message |
|------|---------|--------------|
| `PROVIDER_MISMATCH` | Email registered with different provider | "Email registered using [provider]. Log in with [provider] instead." |
| `EMAIL_NOT_VERIFIED` | Local user hasn't verified email | "Verify your email before logging in." |
| `CANNOT_UNLINK_LAST` | Only authentication method | "Must keep one login method." |
| `INVALID_PROVIDER` | Unsupported provider | "Invalid provider specified." |
| `OAUTH_FAILED` | OAuth authentication failed | "OAuth login failed. Try again or use different method." |

### 9. **Testing Checklist**

- [ ] Sign up with email/password successfully
- [ ] Try sign up with existing Google email → See provider mismatch error
- [ ] Try sign up with existing GitHub email → See provider mismatch error
- [ ] Log in with Google
- [ ] Log in with GitHub
- [ ] Link Google to email/password account
- [ ] Link GitHub to email/password account
- [ ] View all connections in profile
- [ ] Unlink a provider
- [ ] Attempt to unlink last method → See error
- [ ] Log in with newly linked provider
- [ ] Verify email for local auth

### 10. **Environment Variables Required**

For OAuth to work with account linking:
```
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-secret
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-secret
BASE_URL=http://localhost:3000  # or production URL
```

### 11. **Troubleshooting**

#### "Account already exists with this provider"
- User has already connected this provider
- Use login with that provider or unlink first

#### "You don't have permission to link this account"
- Session expired or token invalid
- Log back in and try again

#### "Unable to complete OAuth flow"
- Check GOOGLE/GITHUB credentials in .env
- Verify callback URLs match provider settings
- Clear browser cookies and try again

#### Connection Not Appearing
- Refresh the page
- Check if account linking completed fully
- Try unlinking and linking again

### 12. **Future Enhancements**

Potential additions:
1. Email change with verification
2. Multiple email addresses per account
3. OAuth token refresh and expiration handling
4. Device/session management
5. Login activity history
6. Suspicious login alerts
7. Account recovery via email
8. Passwordless login options
9. WebAuthn/biometric support
10. IP-based device trust

