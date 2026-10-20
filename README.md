
# IdeaVault – Server

## Project Overview

This repository contains the backend API for IdeaVault. It is built with Node.js, Express, and MongoDB, and handles authentication, idea management, comments, searching, and database operations.

## Live API

🔗 https://ideavault-server-wine.vercel.app

---

## Technologies Used

- Node.js
- Express.js
- MongoDB
- Better Auth
- CORS
- Dotenv
- JSON Web Token (JWT)

---

## Features

- RESTful API for managing ideas
- User authentication and authorization
- Create, update, and delete ideas
- Comment management
- Search ideas using keywords
- MongoDB database integration
- Secure API with CORS configuration
- Environment variable support

---

## Main Dependencies

- express
- mongodb
- better-auth
- cors
- dotenv
- jsonwebtoken

---

## Run the Project Locally

### 1. Clone the repository

```bash
git clone https://github.com/Muna-Rahman/ideavault-server.git
cd ideavault-server
2. Install dependencies
npm install
3. Create a .env file
PORT=5000

MONGODB_URI=your_mongodb_connection_string

CLIENT_URL=http://localhost:3000

JWT_SECRET=your_secret_key
4. Start the server
node index.js

or

npm start
5. Test the API

Open

http://localhost:5000

Client Repository: https://github.com/Muna-Rahman/ideavault

If everything is configured correctly, the API should be running successfully.﻿
