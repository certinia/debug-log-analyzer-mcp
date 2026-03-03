# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the Apex Log MCP Server - a Model Context Protocol (MCP) server for Apex Log Analysis. It provides AI agents with tools to analyze Salesforce Apex debug logs for performance bottlenecks and optimization opportunities.

## Development Commands

```bash
# Install dependencies (use npm, not pnpm despite README mention)
npm install

# Build the TypeScript project
npm run build

# Development with watch mode
npm run dev

# Run the server standalone
npm start
```

## Architecture

### Core Components

- **src/index.ts**: Main MCP server implementation (`ApexLogServer` class)
  - Implements 4 MCP tools: `analyze_apex_log_performance`, `get_apex_log_summary`, `find_performance_bottlenecks`, `execute_anonymous`
  - Uses stdio transport for communication
  - Handles file validation, log parsing, analysis, and anonymous Apex execution

- **src/ApexLogParser.ts**: Complex log parsing engine (33k+ tokens)
  - Exports `parse()` function and `ApexLogParser` class
  - Handles Apex debug log format parsing into structured data
  - Tracks governor limits, performance metrics, and log issues

### Key Data Structures

- `ApexLog`: Root log structure with duration, governor limits, namespaces
- `LogLine`: Individual log entries with hierarchical relationships
- `SlowMethod`: Performance analysis result with timing and resource usage
- `GovernorLimits`: Salesforce platform limits tracking

### MCP Integration

This server is designed to integrate with the Apex Log Analyzer VS Code extension:

- Registered automatically by the extension
- Communicates via MCP protocol over stdio
- Provides structured JSON responses for AI analysis

## TypeScript Configuration

- Target: ES2022
- Module: ESNext with Node resolution
- Strict mode enabled
- Output to `dist/` directory
- Source maps and declarations generated

## File Structure

```
src/
  index.ts          # MCP server implementation
  ApexLogParser.ts  # Log parsing engine
dist/               # Compiled JavaScript output
```

## Tools

The server provides four main capabilities:

1. **Performance Analysis**: Identifies slowest methods with detailed metrics
2. **Log Summary**: High-level execution statistics and governor limit usage
3. **Bottleneck Detection**: Analyzes CPU, database, and method performance patterns
4. **Execute Anonymous**: Executes anonymous Apex code snippets and retrieves the resulting debug log

Log analysis tools (1-3) accept absolute file paths to `.log` files and return structured JSON for AI processing.
Anonymous execution (4) accepts multi-line strings containing Apex and returns the entire contents of the log.
