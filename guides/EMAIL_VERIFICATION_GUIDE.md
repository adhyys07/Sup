# Email Verification System Documentation

## Overview
When users sign up using email and password, they now receive a confirmation email with a verification link. Users must verify their email before they can log in.

## Features Implemented

### 1. **Backend Changes**

#### **Database Schema Updates** (`schema.js`)
New fields added to the `users` table:
- `emailVerified` (boolean) - Tracks if email is verified (default: false)
- `emailVerificationToken` (varchar) - Unique token for email verification
- `emailVerificationTokenExpires` (timestamp) - Token expiration time (24 hours)

#### **New API Endpoints** (`server.js`)

##### `POST /api/register`
- **Purpose**: Register a new user with email and password
- **Request Body**:
  ```json
  {
    "name": "John Doe",
    "email": "john@example.com",
    "password": "securepassword"
  }
  ```
- **Response** (201 Created):
  ```json
  {
    "message": "Account created! Please check your email to verify your address.",
    "email": "john@example.com"
  }
  ```
- **Validations**:
  - Email must be unique
  - Password minimum 6 characters
  - All fields required
  - Automatically sends verification email
  - Token valid for 24 hours

##### `POST /api/verify-email`
- **Purpose**: Verify user's email using the token from the email link
- **Request Body**:
  ```json
  {
    "token": "verification_token_here"
  }
  ```
- **Response**:
  ```json
  {
    "message": "Email verified successfully! You can now log in."
  }
  ```
- **Error Handling**:
  - Invalid token returns 400
  - Expired token returns 400
  - Status code 403 if trying to login before verification

##### `POST /api/resend-verification`
- **Purpose**: Resend verification email if user didn't receive it
- **Request Body**:
  ```json
  {
    "email": "john@example.com"
  }
  ```
- **Response**:
  ```json
  {
    "message": "Verification email sent! Please check your inbox."
  }
  ```

#### **Modified Endpoints**

##### `POST /api/login`
- **New Behavior**: Checks if email is verified before allowing login
- **Error Response** (403 Forbidden) if email not verified:
  ```json
  {
    "error": "Please verify your email before logging in. Check your inbox for a verification link."
  }
  ```
- **Note**: OAuth users (Google, GitHub) skip verification and are auto-verified

### 2. **Email Configuration**

#### **Environment Variables Required**
Add these to your `.env` file:
```
EMAIL_SERVICE=gmail  # or your email service
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password  # For Gmail, use App Password
```

#### **Email Template**
- Sender: Configurable via `EMAIL_USER` env variable
- Subject: "Verify your Sup account"
- Content includes:
  - User's name greeting
  - Verification button/link
  - Direct URL option
  - 24-hour expiration notice
  - Info about unsolicited emails

#### **Gmail Setup** (if using Gmail)
1. Enable 2FA on your Gmail account
2. Generate an "App Password" at https://myaccount.google.com/apppasswords
3. Use the 16-character app password as `EMAIL_PASSWORD`
4. Set `EMAIL_USER` to your Gmail address
5. Set `EMAIL_SERVICE=gmail`

### 3. **Frontend Changes**

#### **Email Verification Page** (`verify-email.html`)
- **Features**:
  - Auto-verifies if token in URL (`?token=xxx`)
  - Manual token entry if needed
  - Resend verification email button
  - Beautiful UI with status indicators
  - Loading, success, and error states
  - Back to login link

#### **Registration Flow Updated** (`index.html`)
- After registration, shows success message instead of auto-login
- Displays verification instructions
- Provides "Resend Verification" button
- Clear email address shown

#### **Login Flow Updated** (`index.html`)
- Shows helpful error if email not verified
- Offers quick "Resend Verification Link" button
- Validates password minimum length

### 4. **User Flow**

#### **Sign Up Flow**
1. User fills in Name, Email, Password on registration form
2. Clicks "Register"
3. Server validates and creates account
4. Verification email is sent
5. User sees confirmation message with instructions
6. User clicks link in email or visits verification page
7. Email is marked as verified
8. User can now log in

#### **Login Flow**
1. User enters email and password
2. If not verified:
   - Error message displayed
   - "Resend Verification Link" button available
3. If verified:
   - User logged in successfully
   - Redirected to dashboard

#### **Resend Verification Flow**
1. User clicks "Resend Verification Link" button
2. Enters their email address
3. New verification email is sent with fresh token
4. Previous token is invalidated

## Technical Details

### **Token Generation**
- Uses Node.js `crypto.randomBytes(32).toString('hex')`
- 64-character hexadecimal string
- Stored encrypted in database
- Expires after 24 hours

### **Rate Limiting**
- Registration/verification routes use `authLimiter`
- 10 requests per 15 minutes per IP
- Prevents brute force attacks

### **Email Service Fallback**
- If email service not configured, registration still succeeds
- Verification is skipped in this case
- Warning logged to console
- Useful for development/testing

### **OAuth Integration**
- Google and GitHub users are auto-verified
- No email verification required for social auth
- `authProvider` field determines if check is applied

## Testing

### **Test Email Verification**
```bash
# 1. Start server
npm start

# 2. Open http://localhost:3000
# 3. Register with test email
# 4. Check email for verification link
# 5. Click link or use verify-email.html page
# 6. Login with verified email
```

### **Without Email Service**
```bash
# Remove EMAIL_USER env variable
# Registration will still work
# Email verification will be skipped for testing
```

## Error Handling

### **Common Errors**

| Error | Cause | Solution |
|-------|-------|----------|
| "Email already registered" | Email in use | Use different email |
| "Password must be at least 6 characters" | Weak password | Use stronger password |
| "Please verify your email before logging in" | Email not verified | Check inbox, click verification link |
| "Verification token has expired" | Token older than 24 hours | Request new verification email |
| "Invalid verification token" | Wrong/tampered token | Request new verification email |
| "Failed to send verification email" | Email service misconfigured | Check EMAIL_USER and EMAIL_PASSWORD env vars |

## Security Measures

1. **Token Security**
   - Random 64-character tokens
   - 24-hour expiration
   - One-time use
   - Cannot reuse after verification

2. **Rate Limiting**
   - 10 attempts per 15 minutes
   - Prevents brute force verification attempts

3. **Email Validation**
   - Verified before login
   - OAuth users auto-verified
   - Can only authenticate after email verification

4. **Password Security**
   - Minimum 6 characters
   - Hashed with bcryptjs
   - Never stored in plaintext

## Future Enhancements

Potential additions:
1. Email change verification
2. Password reset via email
3. Multiple email addresses per account
4. Email notification preferences
5. SMTP relay service support
6. Sendgrid/Mailgun integration
7. Email bounce handling
8. Unsubscribe management

## Troubleshooting

### **Verification Email Not Received**
1. Check spam/junk folder
2. Verify EMAIL_USER and EMAIL_PASSWORD are correct
3. Check email service logs
4. Try resending verification email
5. Check browser console for errors

### **Token Expired**
1. User has 24 hours to verify
2. Click "Resend Verification Link"
3. A new token will be generated
4. Old token becomes invalid

### **Already Verified But Getting Error**
1. Clear browser cookies
2. Try logging in again
3. Check database directly if needed
4. Contact support with email address

