# 🛠️ Developing the LANA MCP Server

Welcome to the development guide for the **LANA MCP Server**. This document will walk you through the steps required to get started with the development environment, run the server locally, and contribute to the project.

- The source code is written in [TypeScript](https://www.typescriptlang.org/).
- The tools directory contains the source code for the functionality available on the server.
- The salesforce directory contains a set of utilities for connecting to a Salesforce org.

## 📚 Table of Contents

1. [Prerequisites](#-prerequisites)
2. [Setting Up the Development Environment](#-setting-up-the-development-environment)
3. [Building](#-building)
4. [Running the Server Locally](#-running-the-server-locally)

## 🔧 Prerequisites

Before you start developing, make sure you have the following tools installed:

- **Node.js** v22 or above: [Install Node.js](https://nodejs.org/en/)
- **[pnpm](https://pnpm.io/)**: Preferred package manager
- **[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)**: This is used to connect to a Salesforce org.

Once you’ve got these ready, you’re all set to get started! 🚀

## 💻 Setting Up the Development Environment

To get started, clone this repository and install the necessary dependencies.

1. **Create a fork of the repository first**
2. **Clone the repository:**

   ```zsh
   git clone https://github.com/your-username/debug-log-analyzer-mcp.git
   cd debug-log-analyzer-mcp
   ```

3. **Install dependencies:**

   Use [pnpm](https://pnpm.io/) to install project dependencies:

   ```zsh
   pnpm i
   ```

4. **Optional: Set a default org (execute_anonymous tool only)**

   The execute anonymous Apex tool requires a default org to be set using the Salesforce CLI. To do this in a repository that has no `sfdx-project.json` like this one, set your default org globally:

   ```zsh
   sf config set target-org <username-or-alias> --global
   ```

5. **Optional: Install MCP Inspector**

   This will allow you to view a UI to easily interact with the MCP server:

   ```zsh
   npm install -g @modelcontextprotocol/inspector
   ```

## 📦 Building

You can build the server and prepare it for local development, run the watcher to re build automatically or production use. Here's how:

1. **Watch Build:**

   To build the server and then watch for file changes for a fast dev experience, use:

   ```bash
   pnpm run dev
   ```

2. **Production Build:**

   To build the server, use:

   ```bash
   pnpm run build
   ```

## 🚀 Running the Server Locally

Once you’ve built the server or run the watcher, you can run the MCP server for testing and development.

1. **Run in terminal:**

   ```zsh
   pnpm run start
   ```

2. **Run in MCP Inspector:**

   ```zsh
   mcp-inspector node dist/index.js
   ```

## 🧪 Testing Your Changes

Make sure your changes don’t break anything. If you’re working on a feature or bug fix that requires tests, be sure to add or update the relevant tests.

Run Tests Locally:
If you have added or modified tests, you can run them with:

```zsh
pnpm test
```

or run the tests from the test explorer in VScode

Ensure all tests pass before submitting your pull request.
