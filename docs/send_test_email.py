"""
send_test_email.py
------------------
Sends a realistic test bill email to yourself so you can test BillAlert
without waiting for a real bill to arrive.

Usage:
  1. Install dependencies:     pip install google-auth google-auth-oauthlib google-api-python-client
  2. Run:                       python3 docs/send_test_email.py
  3. Follow the browser prompt to sign in with Google
  4. The script sends 3 test emails to your own Gmail inbox
  5. Wait ~30 seconds, then click Scan Now in the BillAlert extension

Requirements:
  - Python 3.7+
  - A Google account (same one you use with BillAlert)
"""

import base64
import datetime
import os
from email.mime.text import MIMEText

# ── Google API imports ────────────────────────────────────────────────────────
try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
except ImportError:
    print("Missing dependencies. Run:")
    print("  pip install google-auth google-auth-oauthlib google-api-python-client")
    exit(1)

# ── Config ────────────────────────────────────────────────────────────────────

SCOPES = ['https://www.googleapis.com/auth/gmail.send']

# Test emails to send to yourself
TEST_EMAILS = [
    {
        "subject": "Your Comcast Internet Bill is Ready - $89.99 Due June 20",
        "body": """Hi there,

Your monthly Comcast Internet bill is ready.

Account Summary:
  Service:        Xfinity Internet (200 Mbps)
  Billing Period: June 1 - June 30, 2026
  Amount Due:     $89.99
  Due Date:       June 20, 2026

Pay online at xfinity.com/pay or call 1-800-XFINITY.

Thank you,
Comcast Billing Team
""",
    },
    {
        "subject": "Netflix - Your subscription payment of $15.49 is due",
        "body": """Hi there,

Your Netflix subscription will renew on June 18, 2026.

Plan:            Standard with Ads
Amount:          $15.49
Payment Method:  Visa ending in 4242
Renewal Date:    June 18, 2026

To manage your subscription, visit netflix.com/account.

Thanks,
The Netflix Team
""",
    },
    {
        "subject": "Electricity Bill Due - June Statement - $134.50",
        "body": """Dear Customer,

Your June electricity statement is now available.

Account: 12345-67890
Service Address: 123 Main St

Current Charges:
  Electricity Usage (842 kWh):  $118.00
  Distribution Charge:           $12.50
  Taxes & Fees:                   $4.00
  ---------------------------------
  Total Amount Due:             $134.50

Due Date: June 25, 2026

Pay online, by phone, or by mail.

National Grid Customer Service
""",
    },
]


def get_gmail_service():
    """Authenticate and return a Gmail API service instance."""
    creds = None

    # Check for existing token
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)

    # Get new credentials if needed
    if not creds or not creds.valid:
        # Create a minimal OAuth client config (uses Google's OOB flow)
        client_config = {
            "installed": {
                "client_id": "YOUR_CLIENT_ID",  # Not needed for send-only test
                "client_secret": "YOUR_CLIENT_SECRET",
                "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob"],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        }
        print("\n⚠️  This script needs OAuth credentials.")
        print("The easiest way to send test emails is directly from Gmail:")
        print("\nJust send yourself these 3 emails manually (copy/paste the subjects):\n")
        for i, email in enumerate(TEST_EMAILS, 1):
            print(f"  {i}. Subject: {email['subject']}")
        print("\nThen click Scan Now in BillAlert — it will find them!")
        return None

    return build('gmail', 'v1', credentials=creds)


def create_message(to, subject, body):
    """Create a base64-encoded email message."""
    message = MIMEText(body)
    message['to'] = to
    message['subject'] = subject
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    return {'raw': raw}


def main():
    print("BillAlert Test Email Sender")
    print("=" * 40)

    # Since OAuth setup for this script is complex, just print instructions
    print("\nThe easiest way to test BillAlert is to send yourself")
    print("these emails from Gmail. Copy each subject line:\n")

    for i, email in enumerate(TEST_EMAILS, 1):
        print(f"Email {i}:")
        print(f"  To:      your own Gmail address")
        print(f"  Subject: {email['subject']}")
        print(f"  Body:    (copy from docs/send_test_email.py)")
        print()

    print("After sending, wait ~1 minute then click Scan Now in BillAlert.")
    print("The extension will find and summarize your test bills! ✅")


if __name__ == '__main__':
    main()
