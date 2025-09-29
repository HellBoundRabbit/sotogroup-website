# Firebase Setup Guide for SOTO Group Website

## 🚀 Step 1: Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Create a project"
3. Project name: `soto-group-test` (or your preferred name)
4. Enable Google Analytics (optional)
5. Click "Create project"

## 🔧 Step 2: Enable Firestore Database

1. In your Firebase project, go to "Firestore Database"
2. Click "Create database"
3. Choose "Start in test mode" (for development)
4. Select a location (choose closest to your users)
5. Click "Done"

## 🔑 Step 3: Get Firebase Configuration

1. Go to Project Settings (gear icon)
2. Scroll down to "Your apps"
3. Click "Add app" → Web app (</>) icon
4. App nickname: `SOTO Group Website`
5. Check "Also set up Firebase Hosting" (optional)
6. Click "Register app"

## 📋 Step 4: Copy Configuration

You'll get a config object like this:

```javascript
const firebaseConfig = {
  apiKey: "your-api-key",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789012",
  appId: "your-app-id"
};
```

## 🔄 Step 5: Update Test Page

Replace the placeholder config in `pages/test.html` with your real config:

```javascript
const firebaseConfig = {
    apiKey: "YOUR_ACTUAL_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};
```

## 🛡️ Step 6: Set Up Security Rules (Optional)

In Firestore Database → Rules, you can set up security rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Allow read/write access to testMessages collection
    match /testMessages/{document} {
      allow read, write: if true; // For testing only!
    }
  }
}
```

## ✅ Step 7: Test Your Setup

1. Open `http://localhost:8000/pages/test.html`
2. Click "Test Firebase Connection"
3. Type a message and click "Process Input"
4. Click "Read Message" to retrieve it

## 🔥 Firebase Features You Get

- **Real-time database** - Live updates
- **Free tier** - 1GB storage, 20K reads/day
- **Easy queries** - Simple JavaScript API
- **Authentication** - Built-in user management
- **Hosting** - Deploy your website
- **Analytics** - Track usage

## 📊 Database Schema

Your test page creates documents in the `testMessages` collection:

```javascript
{
  messageText: "User input text",
  timestamp: Firestore.Timestamp,
  messageId: "msg_1234567890",
  createdAt: "2024-01-01T00:00:00.000Z"
}
```

## 🚀 Next Steps

Once Firebase is working, you can:

1. **Migrate your routes system** to use Firestore
2. **Add authentication** for user management
3. **Set up real-time updates** for live data
4. **Deploy to Firebase Hosting** for production

## 💡 Pro Tips

- Use Firebase Console to view/manage your data
- Set up proper security rules for production
- Consider using Firebase Auth for user management
- Use Firebase Functions for server-side logic
- Monitor usage in the Firebase Console

---

**Ready to test!** 🎉
