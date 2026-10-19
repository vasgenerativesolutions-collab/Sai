# Sai Traders — Enterprise Windows Desktop Application

Official native Windows desktop application for Shree Sai Traders Saree Retail Operations, Live Inventory Management, TallyPrime ERP synchronization, and External Storefront REST APIs.

---

## 🌟 Key Features

- **Native Windows Desktop Window**: Clean desktop application powered by Electron — no browser tabs, no address bars, custom luxury theme.
- **System Tray Minimization**: Runs continuously in the background near the Windows clock to process WhatsApp and Webstore orders 24/7.
- **TallyPrime ERP Connector**: Real-time two-way synchronization with Tally ERP under the dedicated **`Sarees`** godown.
- **AI Visual Saree Search**: Multimodal saree photo and drape video keyframe matching powered by Google Gemini AI.
- **Storefront REST APIs & Webhooks**: Integrated endpoints for external Angular / Web storefronts with instant inventory decrement, Tally Sales Voucher generation, and Google Sheets logging.
- **Automatic Windows Boot Startup**: Configurable to auto-launch on PC boot with zero manual setup.

---

## 🚀 Quick Start Guide

### 1. Installation
Clone the repository:
```bash
git clone https://github.com/vasgenerativesolutions-collab/Sai.git
cd Sai
```

### 2. Configuration
Copy `.env.example` to `.env` and fill in your Supabase, Gemini, and Meta credentials:
```bash
copy .env.example .env
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Run the Application
- **Option A (One-Click Runner):** Double-click **`RUN_DESKTOP_APP.bat`**.
- **Option B (Command Line):**
  ```bash
  npm run desktop
  ```

---

## 📁 Repository Structure

```
├── admin/               # Backend Express Server & Storefront REST APIs
│   ├── public/          # Admin Dashboard Frontend Assets (HTML, CSS, JS)
│   └── server.js        # Core ERP & Webhook Router
├── desktop/             # Electron Native Desktop Application
│   └── main.js          # Native Window, System Tray & Process Lifecycle
├── RUN_DESKTOP_APP.bat  # Double-click launcher for the desktop application
├── RUN_SAI_TRADERS.bat  # Server & Cloudflare tunnel launcher
├── package.json         # Project metadata & Electron dependencies
└── .env.example         # Environment template
```
