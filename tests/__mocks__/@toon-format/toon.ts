/*
 * Copyright (c) 2025 Certinia Inc. All rights reserved.
 */

// Manual mock for @toon-format/toon to avoid ESM/CommonJS compatibility issues in Jest

export const encode = (data: any): string => {
  return JSON.stringify(data);
};

export const decode = (data: string): any => {
  return JSON.parse(data);
};

export const DEFAULT_DELIMITER = "\n";
export const DELIMITERS = {
  NEWLINE: "\n",
  PIPE: "|",
  COMMA: ",",
};
