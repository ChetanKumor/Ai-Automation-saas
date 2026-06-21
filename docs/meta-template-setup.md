# WhatsApp Template Message Setup

When a customer hasn't messaged your business within 24 hours, WhatsApp
requires you to use a pre-approved **Message Template** to initiate
contact. Without this, appointment reminders for inactive customers
will be skipped (status: `needs_template`).

## Prerequisites

1. **Meta Business Verification** — required before template approval.
2. **WhatsApp Business Platform** access (you already have this via Cloud API).

## Step-by-step

### 1. Verify your business on Meta

1. Go to [Meta Business Settings](https://business.facebook.com/settings/security)
2. Click "Start Verification"
3. Provide business documents (GST certificate, PAN, business registration)
4. Wait 2-5 business days for approval

### 2. Create an appointment reminder template

1. Go to [WhatsApp Manager → Message Templates](https://business.facebook.com/wa/manage/message-templates/)
2. Click "Create Template"
3. Settings:
   - **Category:** Utility
   - **Name:** `appointment_reminder` (or your preferred name)
   - **Language:** English (add Hindi/Telugu as additional languages later)
4. Template body (use these exact variables):
   ```
   Reminder: {{1}}, your appointment with {{2}} is on {{3}} at {{4}}. See you soon!
   ```
   Where:
   - `{{1}}` = Patient name
   - `{{2}}` = Doctor name
   - `{{3}}` = Date and time (IST)
   - `{{4}}` = Clinic name
5. Submit for review (takes 1-24 hours)

### 3. Configure in your CRM

Once the template is approved, update your tenant record:

```sql
UPDATE tenants
SET reminder_template_id = 'appointment_reminder'
WHERE id = '<your-tenant-uuid>';
```

That's it — the reminder cron will automatically use the template for
customers outside the 24h window. No code changes needed.

## How the system decides what to send

```
Customer messaged within 24h?
├── YES → Send free-text reminder (no template needed)
└── NO
    ├── reminder_template_id is set → Send template message
    └── reminder_template_id is NULL → Skip, log 'needs_template'
```

## Template best practices

- Keep it under 1024 characters
- Don't include promotional content (use "Utility" category)
- Include a clear business identity (clinic name)
- Multi-language: create the same template in `hi` (Hindi) and `te` (Telugu)
  to match your patient demographics

## Monitoring skipped reminders

Check which reminders were skipped due to missing templates:

```sql
SELECT n.content, n.created_at
FROM notifications n
WHERE n.type = 'reminder' AND n.sent_status = 'needs_template'
ORDER BY n.created_at DESC;
```

## Cost

- Free-text messages (within 24h): included in your conversation quota
- Template messages: ~₹0.47 per utility message (India pricing, as of 2025)
