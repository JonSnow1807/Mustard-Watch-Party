# 🚀 Deployment Guide for Mustard Watch Party

This guide will walk you through deploying your Mustard Watch Party application to Render (backend) and Vercel (frontend).

## 📋 Prerequisites

- [GitHub](https://github.com) account with your code
- [Render](https://render.com) account
- [Vercel](https://vercel.com) account
- [PostgreSQL](https://www.postgresql.org/) database (Render provides this)

## 🔧 Backend Deployment on Render

### Step 1: Prepare Your Repository

1. **Push your code to GitHub** (if not already done):
   ```bash
   git add .
   git commit -m "Prepare for deployment"
   git push origin main
   ```

2. **Ensure your repository is public** or connected to Render

### Step 2: Deploy on Render

1. **Go to [Render Dashboard](https://dashboard.render.com)**
2. **Click "New +" → "Web Service"**
3. **Connect your GitHub repository**
4. **Configure the service:**

   **Basic Settings:**
   - **Name**: `mustard-watch-party-backend`
   - **Environment**: `Node`
   - **Region**: Choose closest to your users
   - **Branch**: `main`
   - **Root Directory**: `video-sync-backend`

   **Build & Deploy:**
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `npm run start:prod`

   **Environment Variables:**
   ```
   NODE_ENV=production
   PORT=10000
   JWT_SECRET=your-super-secret-jwt-key-here
   FRONTEND_URL=https://your-frontend-domain.vercel.app
   ```

5. **Click "Create Web Service"**

### Step 3: Set Up Database

1. **In Render Dashboard, click "New +" → "PostgreSQL"**
2. **Configure:**
   - **Name**: `mustard-watch-party-db`
   - **Database**: `mustardwatchparty`
   - **User**: `mustardwatchparty`
   - **Plan**: `Starter` (free tier)
3. **Click "Create Database"**
4. **Copy the connection string**
5. **Go back to your web service → Environment → Add Environment Variable:**
   - **Key**: `DATABASE_URL`
   - **Value**: Paste the connection string from step 4

### Step 4: Run Database Migrations

1. **In your web service, go to "Shell"**
2. **Run the migration command:**
   ```bash
   npm run db:migrate
   ```

## 🌐 Frontend Deployment on Vercel

### Step 1: Deploy on Vercel

1. **Go to [Vercel Dashboard](https://vercel.com/dashboard)**
2. **Click "New Project"**
3. **Import your GitHub repository**
4. **Configure the project:**

   **Framework Preset**: `Create React App`
   **Root Directory**: `video-sync-frontend`
   **Build Command**: `npm run build`
   **Output Directory**: `build`
   **Install Command**: `npm ci`

5. **Click "Deploy"**

### Step 2: Configure Environment Variables

1. **In your Vercel project, go to Settings → Environment Variables**
2. **Add the following variables:**

   **Production:**
   ```
   REACT_APP_API_URL=https://your-backend-domain.onrender.com/api
   REACT_APP_WS_URL=wss://your-backend-domain.onrender.com
   ```

   **Preview:**
   ```
   REACT_APP_API_URL=https://your-backend-domain.onrender.com/api
   REACT_APP_WS_URL=wss://your-backend-domain.onrender.com
   ```

3. **Click "Save"**
4. **Redeploy your project**

## 🔗 Update Frontend URL in Backend

After deploying your frontend, update the `FRONTEND_URL` in your Render backend:

1. **Go to your Render web service**
2. **Environment → Edit Environment Variable**
3. **Update `FRONTEND_URL`** with your actual Vercel domain
4. **Redeploy the service**

## ✅ Verification Steps

### Backend Health Check
- Visit: `https://your-backend-domain.onrender.com/health`
- Should return: `{"status":"ok","timestamp":"..."}`

### Frontend Connection
- Open your Vercel app
- Check browser console for WebSocket connection status
- Try creating/joining a room

### Database Connection
- Check Render logs for successful database connection
- Verify migrations ran successfully

## 🚨 Troubleshooting

### Common Issues:

1. **CORS Errors**
   - Ensure `FRONTEND_URL` is set correctly in backend
   - Check that the URL matches exactly (including protocol)

2. **Database Connection Issues**
   - Verify `DATABASE_URL` is correct
   - Check if database is accessible from your region
   - Ensure migrations have run

3. **WebSocket Connection Issues**
   - Verify `REACT_APP_WS_URL` is set correctly
   - Check that backend supports WebSocket connections
   - Ensure no firewall blocking WebSocket traffic

4. **Build Failures**
   - Check that all dependencies are in `package.json`
   - Verify Node.js version compatibility
   - Check build logs for specific errors

### Debug Commands:

**Backend Logs:**
```bash
# In Render dashboard → Logs
# Look for connection messages and errors
```

**Frontend Console:**
```bash
# Open browser dev tools
# Check Console and Network tabs
# Look for WebSocket connection status
```

## 🔄 Continuous Deployment

Both Render and Vercel will automatically redeploy when you push to your main branch.

**To update your app:**
1. Make changes locally
2. Test thoroughly
3. Commit and push to GitHub
4. Wait for automatic deployment (usually 2-5 minutes)

## 📊 Monitoring

### Render Monitoring:
- **Logs**: Real-time application logs
- **Metrics**: CPU, memory, response time
- **Health Checks**: Automatic uptime monitoring

### Vercel Monitoring:
- **Analytics**: Page views, performance
- **Functions**: API call metrics
- **Deployments**: Build and deployment history

## 🎉 You're Deployed!

Your Mustard Watch Party app should now be running on:
- **Backend**: `https://your-backend-domain.onrender.com`
- **Frontend**: `https://your-frontend-domain.vercel.app`

Share the frontend URL with your friends and start watching videos together! 🎬✨
