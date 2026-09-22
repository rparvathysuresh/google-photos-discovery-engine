# Railway Deployment Plan

This document outlines the step-by-step process for deploying the Google Photos Discovery Engine to [Railway](https://railway.app/). 

Because the project uses a unified architecture (Express backend serving a statically built Vite/React frontend), deployment is incredibly straightforward. Railway will automatically detect the Node.js environment and run the appropriate scripts.

---

## 1. Prerequisites

Before deploying, ensure you have:
1. A GitHub account with the code pushed to a repository (e.g., `rparvathysuresh/google-photos-discovery-engine`).
2. A Railway account (you can sign in with GitHub at [railway.app](https://railway.app)).
3. Your Groq API Key (`GROQ_API_KEY`).

---

## 2. Step-by-Step Deployment Guide

### Step 1: Create a New Project on Railway
1. Log in to your Railway dashboard.
2. Click the **"New Project"** button.
3. Select **"Deploy from GitHub repo"**.
4. Authorize Railway to access your GitHub repositories if you haven't already.
5. Select the repository: `rparvathysuresh/google-photos-discovery-engine`.

### Step 2: Configure Environment Variables
Before the first deployment finishes, you need to add your API key so the AI Chat feature works.
1. In the Railway dashboard for your new project, click on your service.
2. Navigate to the **"Variables"** tab.
3. Add a new variable:
   - **Key:** `GROQ_API_KEY`
   - **Value:** *(Paste your Groq API key here)*

### Step 3: Wait for Build & Deploy
Railway uses the `package.json` to determine how to build and run your app. 
- It will automatically run `npm install`.
- It will detect the `build` script (`cd client && npm install && npm run build`) and execute it to compile the React frontend.
- It will detect the `start` script (`node server/index.js`) and run it to launch the server.

You can monitor the progress in the **"Deployments"** tab by clicking on "View Logs".

### Step 4: Generate a Public Domain
Once the deployment is marked as "Success", you need a URL to access it.
1. Click on your service in the Railway dashboard.
2. Go to the **"Settings"** tab.
3. Under the **"Networking"** section, click **"Generate Domain"**.
4. Railway will provide you with a `.up.railway.app` URL (e.g., `google-photos-production.up.railway.app`).

### Step 5: Test the Live Application
1. Click on your newly generated domain URL.
2. Verify that the Executive Summary, Opportunity Clusters, and Data Explorer load correctly (this confirms the static `data/` files were deployed).
3. Navigate to the **"Ask AI"** tab and send a message. If it responds, your `GROQ_API_KEY` is configured correctly and the backend is successfully proxying requests to Groq!

---

## 3. Troubleshooting

- **Build Fails:** Check the Railway deployment logs. Ensure that `node_modules` is not pushed to GitHub, which can cause conflicts. (We verified it is correctly ignored in `.gitignore`).
- **AI Chat throws a 500/Error:** Double-check that your `GROQ_API_KEY` in the Variables tab is exactly correct without any extra spaces.
- **Data missing (blank page):** Ensure the `data/` folder was pushed to GitHub. We specifically un-ignored this in `.gitignore` so Railway has access to the pre-generated mock data.
