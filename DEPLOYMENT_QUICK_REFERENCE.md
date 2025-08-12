# 🚀 Deployment Quick Reference

## 🔗 Quick Links
- **Render Dashboard**: https://dashboard.render.com
- **Vercel Dashboard**: https://vercel.com/dashboard
- **Detailed Guide**: [DEPLOYMENT.md](./DEPLOYMENT.md)

## ⚡ Quick Commands

### Prepare for Deployment
```bash
# Run the deployment script
./deploy.sh

# Or manually:
git add .
git commit -m "Prepare for deployment"
git push origin main
```

### Backend (Render)
```bash
# Build locally to test
cd video-sync-backend
npm ci
npm run build
npm run start:prod
```

### Frontend (Vercel)
```bash
# Build locally to test
cd video-sync-frontend
npm ci
npm run build
npm start
```

## 🔧 Environment Variables

### Backend (Render)
```
NODE_ENV=production
PORT=10000
JWT_SECRET=your-super-secret-jwt-key-here
DATABASE_URL=postgresql://... (from Render database)
FRONTEND_URL=https://your-frontend-domain.vercel.app
```

### Frontend (Vercel)
```
REACT_APP_API_URL=https://your-backend-domain.onrender.com/api
REACT_APP_WS_URL=wss://your-backend-domain.onrender.com
```

## 📍 Important URLs

### Health Check
- Backend: `https://your-backend-domain.onrender.com/health`
- Should return: `{"status":"ok","timestamp":"..."}`

### API Endpoints
- Base: `https://your-backend-domain.onrender.com/api`
- Auth: `/api/auth/login`, `/api/auth/register`
- Rooms: `/api/rooms`

## 🚨 Common Issues

### CORS Error
- Check `FRONTEND_URL` in backend environment variables
- Ensure exact URL match (including protocol)

### Database Connection
- Verify `DATABASE_URL` is correct
- Run migrations: `npm run db:migrate`

### WebSocket Issues
- Check `REACT_APP_WS_URL` in frontend
- Verify backend supports WebSocket connections

## 📱 Deployment Order
1. **Backend first** (Render)
2. **Database setup** (PostgreSQL on Render)
3. **Frontend second** (Vercel)
4. **Update backend** with frontend URL
5. **Test connections**

## 🔄 Update Process
```bash
# Make changes locally
git add .
git commit -m "Update description"
git push origin main

# Auto-deploy on both platforms
# Wait 2-5 minutes for completion
```

---
**Need help?** Check the detailed [DEPLOYMENT.md](./DEPLOYMENT.md) guide! 📖
