// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export type SettingsTreeFieldValue =
  | { input: "autocomplete"; value?: string; items: string[] }
  | { input: "boolean"; value?: boolean }
  | { input: "color"; value?: string }
  | { input: "gradient"; value?: string }
  | { input: "messagepath"; value?: string; validTypes?: string[] }
  | { input: "number"; value?: number }
  | { input: "select"; value?: string; options: string[] }
  | { input: "string"; value?: string }
  | { input: "toggle"; value?: string; options: string[] };

export type SettingsTreeField = SettingsTreeFieldValue & {
  label: string;
  help?: string;
  placeholder?: string;
};

export type SettingsTreeFields = Record<string, SettingsTreeField>;
export type SettingsTreeChildren = Record<string, SettingsTreeNode>;

export type SettingsTreeNode = {
  label?: string;
  fields?: SettingsTreeFields;
  children?: SettingsTreeChildren;
};

export type SettingsTreeAction = {
  action: "update";
  payload: { path: readonly string[]; value: unknown };
};

/**
 * A settings tree is a tree of panel settings that can be managed by
 * a default user interface in Studio.
 */
export type SettingsTree = {
  actionHandler: (action: SettingsTreeAction) => void;
  settings: SettingsTreeNode;
};