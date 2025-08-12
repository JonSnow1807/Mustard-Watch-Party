#!/bin/bash

# 🚀 Mustard Watch Party Deployment Script
# This script helps prepare your project for deployment

echo "🚀 Preparing Mustard Watch Party for deployment..."

# Check if we're in the right directory
if [ ! -f "video-sync-backend/package.json" ] || [ ! -f "video-sync-frontend/package.json" ]; then
    echo "❌ Error: Please run this script from the root directory of the project"
    exit 1
fi

# Update backend dependencies
echo "📦 Updating backend dependencies..."
cd video-sync-backend
npm ci
npm run build
cd ..

# Update frontend dependencies
echo "📦 Updating frontend dependencies..."
cd video-sync-frontend
npm ci
npm run build
cd ..

# Check git status
echo "🔍 Checking git status..."
if [ -z "$(git status --porcelain)" ]; then
    echo "✅ Working directory is clean"
else
    echo "⚠️  Working directory has uncommitted changes:"
    git status --short
    echo ""
    read -p "Do you want to commit these changes? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git add .
        git commit -m "Prepare for deployment"
        echo "✅ Changes committed"
    else
        echo "⚠️  Please commit or stash your changes before deploying"
        exit 1
    fi
fi

# Push to remote
echo "📤 Pushing to remote repository..."
git push origin main

echo ""
echo "🎉 Deployment preparation complete!"
echo ""
echo "Next steps:"
echo "1. Deploy backend to Render: https://dashboard.render.com"
echo "2. Deploy frontend to Vercel: https://vercel.com/dashboard"
echo "3. Follow the detailed guide in DEPLOYMENT.md"
echo ""
echo "Happy deploying! 🚀"
