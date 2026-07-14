# Project Zyon

> AI Voice Receptionist • AI WhatsApp Receptionist • Customer Operations Platform

Rovenad is an AI-powered Customer Operations Platform that enables businesses to automate customer communication across voice calls and WhatsApp while maintaining a unified customer memory.

The platform is designed for Indian SMBs and initially targets dental clinics, providing multilingual AI receptionists capable of answering calls, booking appointments, responding on WhatsApp, and seamlessly handing conversations over to human operators when needed.

---

## Features

### AI Voice Receptionist
- Answer incoming calls automatically
- Multilingual conversations (English, Telugu, Hindi)
- Appointment booking
- Human handoff
- Call summaries

### AI WhatsApp Receptionist
- Automated customer support
- FAQ handling
- Appointment booking
- Reminder messages
- Follow-up conversations

### CRM
- Customer management
- Conversation history
- Appointment tracking
- Unified customer timeline

### Knowledge Base
- Retrieval-Augmented Generation (RAG)
- Business-specific knowledge
- AI context retrieval

### Workflow Automation
- Trigger-based workflows
- Event-driven automation
- Notifications
- Follow-up actions

### Multi-Tenant Platform
- Tenant isolation
- Configuration management
- Validation pipeline
- Secure data separation

---

## Technology Stack

### Backend

- Node.js
- Express
- PostgreSQL
- Raw SQL
- Gemini 2.5 Flash
- LiveKit
- Sarvam AI
- Plivo
- Railway

### Frontend

- React
- TypeScript
- Material UI

### AI

- Gemini 2.5 Flash
- RAG
- Tool Calling
- Conversation Memory

---

## Architecture

The platform follows a modular monolith architecture.

```
User
    │
    ▼
API Layer
    │
    ▼
Business Modules
    │
    ├── CRM
    ├── AI
    ├── Voice
    ├── WhatsApp
    ├── Workflow
    ├── Knowledge Base
    ├── Appointments
    └── Configuration
    │
    ▼
PostgreSQL
```

---

## Current Status

Project Status: **Pre-Launch**

Current focus:

- Production deployment
- Voice telephony integration
- Performance optimization
- UI refinement
- First customer onboarding

---

## Roadmap

- [x] Multi-tenant architecture
- [x] CRM
- [x] WhatsApp AI
- [x] Workflow engine
- [x] Knowledge Base
- [x] Human handoff
- [x] Configuration management
- [x] Validation pipeline
- [ ] Production telephony
- [ ] First production deployment
- [ ] First paying customer

---

## Project Vision

Build the AI Operating System for businesses.

Our goal is to help businesses automate customer operations through AI while allowing human teams to focus on high-value work.

---

## Repository Structure

```
src/
voice-agent/
web/
docs/
scripts/
migrations/
tests/
```

---

## Development

Install dependencies

```bash
npm install
```

Run development server

```bash
npm run dev
```

Run tests

```bash
npm test
```

---

## License

Private repository. All rights reserved.

---

Built with ❤️ using AI, Node.js, PostgreSQL, LiveKit, Sarvam, and Gemini.