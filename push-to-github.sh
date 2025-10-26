#!/bin/bash

echo "🚀 Automated GitHub Push Script"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Get GitHub repo URL
echo ""
echo "Enter your GitHub repository URL:"
echo "Example: https://github.com/username/repo-name.git"
read -r REPO_URL

if [ -z "$REPO_URL" ]; then
    echo "❌ No repository URL provided"
    exit 1
fi

# Add remote
echo ""
echo "📡 Adding remote..."
git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"

# Push
echo "📤 Pushing to GitHub (force mode)..."
git push -u origin main --force

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Done! Check your GitHub repo."
