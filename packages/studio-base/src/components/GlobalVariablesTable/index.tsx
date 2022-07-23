// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2020-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { Callout, DefaultButton } from "@fluentui/react";
import CloseIcon from "@mdi/svg/svg/close.svg";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import DoneIcon from "@mui/icons-material/Done";
import EditIcon from "@mui/icons-material/Edit";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import {
  Card,
  Collapse,
  Divider,
  InputBase,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { partition, pick, union, without } from "lodash";
import { useEffect, useMemo, useCallback, useRef, useState, ReactElement } from "react";
import JSONTree from "react-json-tree";
import styled, { css, FlattenSimpleInterpolation, keyframes } from "styled-components";

import Icon from "@foxglove/studio-base/components/Icon";
import JsonInput from "@foxglove/studio-base/components/JsonInput";
import { LegacyTable } from "@foxglove/studio-base/components/LegacyStyledComponents";
import { Item, Menu } from "@foxglove/studio-base/components/Menu";
import Tooltip from "@foxglove/studio-base/components/Tooltip";
import { JSONInput } from "@foxglove/studio-base/components/input/JSONInput";
import { ValidatedResizingInput } from "@foxglove/studio-base/components/input/ValidatedResizingInput";
import useGlobalVariables, {
  GlobalVariables,
} from "@foxglove/studio-base/hooks/useGlobalVariables";
import useLinkedGlobalVariables from "@foxglove/studio-base/panels/ThreeDimensionalViz/Interactions/useLinkedGlobalVariables";
import { useJsonTreeTheme } from "@foxglove/studio-base/util/globalConstants";
import {
  colors,
  colors as sharedColors,
  fonts,
} from "@foxglove/studio-base/util/sharedStyleConstants";

// The minimum amount of time to wait between showing the global variable update animation again
export const ANIMATION_RESET_DELAY_MS = 3000;

// Returns an keyframe object that animates between two styles– "highlight twice then return to normal"
export const makeFlashAnimation = (
  initialCssProps: FlattenSimpleInterpolation,
  highlightCssProps: FlattenSimpleInterpolation,
): FlattenSimpleInterpolation => {
  return css`
    ${keyframes`
      0%, 20%, 100% {
        ${initialCssProps}
      }
      10%, 30%, 80% {
        ${highlightCssProps}
      }
    `}
  `;
};

const SGlobalVariablesTable = styled.div`
  display: flex;
  flex-direction: column;
  white-space: nowrap;

  table {
    width: calc(100% + 1px);
  }

  thead {
    user-select: none;
    border-bottom: 1px solid ${sharedColors.BORDER_LIGHT};
  }

  th,
  td {
    line-height: 100%;
    padding: 8px 4px !important;
    border: none;
  }

  tr:first-child th {
    border: none;
    text-align: left;
  }

  td {
    input {
      background: none !important;
      color: ${({ theme }) => theme.semanticColors.inputText};
      width: 100%;
      min-width: 5em;
      padding: 0;
      border: 0;
      font: inherit;
      font-family: ${fonts.SANS_SERIF};
      font-feature-settings: ${fonts.SANS_SERIF_FEATURE_SETTINGS};
      font-size: 100%;
    }
    input:focus {
      outline: none;
    }
  }
`;

const SIconWrapper = styled.span<{ isOpen?: boolean }>`
  display: inline-block;
  cursor: pointer;
  padding: 0;

  svg {
    opacity: ${({ isOpen = false }) => (isOpen ? 1 : undefined)};
  }
`;

const SLinkedTopicsSpan = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  max-width: 240px;
  margin-left: -5px;
`;

const FlashRowAnimation = makeFlashAnimation(
  css`
    background: transparent;
  `,
  css`
    background: ${sharedColors.HIGHLIGHT_MUTED};
  `,
);

const AnimationDuration = 3;
const SAnimatedRow = styled.tr<{ animate: boolean; skipAnimation: boolean }>`
  background: transparent;
  animation: ${({ animate, skipAnimation }) =>
      animate && !skipAnimation ? FlashRowAnimation : "none"}
    ${AnimationDuration}s ease-in-out;
  animation-iteration-count: 1;
  animation-fill-mode: forwards;
  border-bottom: 1px solid ${sharedColors.BORDER_LIGHT};
`;

export function isActiveElementEditable(): boolean {
  const activeEl = document.activeElement;
  return (
    activeEl != undefined &&
    ((activeEl as HTMLElement).isContentEditable ||
      activeEl.tagName === "INPUT" ||
      activeEl.tagName === "TEXTAREA")
  );
}

const changeGlobalKey = (
  newKey: string,
  oldKey: string,
  globalVariables: GlobalVariables,
  idx: number,
  overwriteGlobalVariables: (_: GlobalVariables) => void,
) => {
  const keys = Object.keys(globalVariables);
  overwriteGlobalVariables({
    ...pick(globalVariables, keys.slice(0, idx)),
    [newKey]: globalVariables[oldKey],
    ...pick(globalVariables, keys.slice(idx + 1)),
  });
};

function LinkedGlobalVariableRow({ name }: { name: string }): ReactElement {
  const jsonTreeTheme = useJsonTreeTheme();
  const [open, setOpen] = useState<boolean>(false);
  const [editing, setEditing] = useState<boolean>(false);
  const { globalVariables, setGlobalVariables } = useGlobalVariables();
  const { linkedGlobalVariables, setLinkedGlobalVariables } = useLinkedGlobalVariables();

  const linkedTopicPaths = useMemo(
    () =>
      linkedGlobalVariables
        .filter((variable) => variable.name === name)
        .map(({ topic, markerKeyPath }) => [topic, ...markerKeyPath].join(".")),
    [linkedGlobalVariables, name],
  );

  const unlink = useCallback(
    (path: string) => {
      setLinkedGlobalVariables(
        linkedGlobalVariables.filter(
          ({ name: varName, topic, markerKeyPath }) =>
            !(varName === name && [topic, ...markerKeyPath].join(".") === path),
        ),
      );
    },
    [linkedGlobalVariables, name, setLinkedGlobalVariables],
  );

  const unlinkAndDelete = useCallback(() => {
    const newLinkedGlobalVariables = linkedGlobalVariables.filter(
      ({ name: varName }) => varName !== name,
    );
    setLinkedGlobalVariables(newLinkedGlobalVariables);
    setGlobalVariables({ [name]: undefined });
  }, [linkedGlobalVariables, name, setGlobalVariables, setLinkedGlobalVariables]);

  const moreButton = useRef<HTMLElement>(ReactNull);

  return (
    <Stack>
      <ListItem
        dense
        component="div"
        disablePadding
        secondaryAction={
          <Stack direction="row" style={{ marginRight: -12 }}>
            <IconButton
              onClick={() => {
                if (!open && !editing) {
                  setOpen(true);
                }
                setEditing(!editing);
              }}
              size="small"
            >
              {editing ? <DoneIcon fontSize="small" /> : <EditIcon fontSize="small" />}
            </IconButton>
            <IconButton size="small">
              <MoreVertIcon fontSize="small" />
            </IconButton>
          </Stack>
        }
      >
        <ListItemButton onClick={() => setOpen(!open)}>
          <ListItemText
            primary={
              <Stack direction="row" alignItems="center" style={{ marginLeft: -12 }}>
                {open ? (
                  <ArrowDropDownIcon />
                ) : (
                  <ArrowDropDownIcon style={{ transform: "rotate(-90deg)" }} />
                )}
                {name}
              </Stack>
            }
            primaryTypographyProps={{
              component: "div",
              fontWeight: 600,
              variant: "body2",
            }}
          />
        </ListItemButton>
      </ListItem>
      <Collapse in={open} sx={{ bgcolor: "action.hover" }}>
        <Divider />
        <Stack paddingBottom={1} paddingTop={0.5} paddingX={1.25}>
          {editing ? (
            <InputBase
              autoFocus
              size="small"
              multiline
              value={JSON.stringify(globalVariables[name], undefined, 2)}
              inputProps={{
                style: {
                  fontFamily: fonts.MONOSPACE,
                },
              }}
            />
          ) : (
            <JSONTree
              data={globalVariables[name]}
              shouldExpandNode={(_markerKeyPath, _data, level) => level < 2}
              invertTheme={false}
              postprocessValue={maybePlainObject}
              theme={{ ...jsonTreeTheme, tree: { margin: 0 } }}
              hideRoot
            />
          )}
        </Stack>
      </Collapse>
      {/* <td>${name}</td>
      <td width="100%">
        <JSONInput
          value={JSON.stringify(globalVariables[name]) ?? ""}
          onChange={(newVal) => setGlobalVariables({ [name]: newVal })}
        />
      </td>
      <td>
        <Stack direction="row" flex="auto" alignItems="center" justifyContent="space-between">
          <Stack direction="row" flex="auto" marginRight={2}>
            {linkedTopicPaths.length > 1 && <span>({linkedTopicPaths.length})</span>}

            <Tooltip
              contents={
                linkedTopicPaths.length > 0 ? (
                  <>
                    <div style={{ fontWeight: "bold", opacity: 0.4 }}>
                      {linkedTopicPaths.length} LINKED TOPIC{linkedTopicPaths.length > 1 ? "S" : ""}
                    </div>
                    {linkedTopicPaths.map((path) => (
                      <div key={path} style={{ paddingTop: "5px" }}>
                        {path}
                      </div>
                    ))}
                  </>
                ) : undefined
              }
            >
              <SLinkedTopicsSpan>
                {linkedTopicPaths.length > 0 ? <bdi>{linkedTopicPaths.join(", ")}</bdi> : "--"}
              </SLinkedTopicsSpan>
            </Tooltip>
          </Stack>
          <IconButton
            elementRef={moreButton}
            iconProps={{ iconName: "MoreVertical" }}
            onClick={() => setIsOpen(!isOpen)}
          >
            {isOpen && (
              // use Callout instead of a menu on the button for now so that we can style the menu text
              <Callout target={moreButton} isBeakVisible={false} onDismiss={() => setIsOpen(false)}>
                <Menu style={{ padding: "4px 0px" }}>
                  {linkedTopicPaths.map((path) => (
                    <Item dataTest="unlink-path" key={path} onClick={() => unlink(path)}>
                      <span>
                        Remove <span style={{ color: sharedColors.LIGHT, opacity: 1 }}>{path}</span>
                      </span>
                    </Item>
                  ))}
                  <Item onClick={unlinkAndDelete}>Delete variable</Item>
                </Menu>
              </Callout>
            )}
          </IconButton>
        </Stack>
      </td> */}
      <Divider />
    </Stack>
  );
}

function maybePlainObject(rawVal: unknown) {
  if (typeof rawVal === "object" && rawVal && "toJSON" in rawVal) {
    return (rawVal as { toJSON: () => unknown }).toJSON();
  }
  return rawVal;
}

function GlobalVariablesTable(): ReactElement {
  const { globalVariables, setGlobalVariables, overwriteGlobalVariables } = useGlobalVariables();
  const { linkedGlobalVariablesByName } = useLinkedGlobalVariables();
  const globalVariableNames = useMemo(() => Object.keys(globalVariables), [globalVariables]);

  const [linked, unlinked] = useMemo(() => {
    return partition(globalVariableNames, (name) => !!linkedGlobalVariablesByName[name]);
  }, [globalVariableNames, linkedGlobalVariablesByName]);

  // Don't run the animation when the Table first renders
  const skipAnimation = useRef<boolean>(true);
  useEffect(() => {
    const timeoutId = setTimeout(() => (skipAnimation.current = false), ANIMATION_RESET_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, []);

  const previousGlobalVariablesRef = useRef<GlobalVariables | undefined>(globalVariables);

  const [changedVariables, setChangedVariables] = useState<string[]>([]);
  useEffect(() => {
    if (skipAnimation.current || isActiveElementEditable()) {
      previousGlobalVariablesRef.current = globalVariables;
      return;
    }
    const newChangedVariables = union(
      Object.keys(globalVariables),
      Object.keys(previousGlobalVariablesRef.current ?? {}),
    ).filter((name) => {
      const previousValue = previousGlobalVariablesRef.current?.[name];
      return previousValue !== globalVariables[name];
    });

    setChangedVariables(newChangedVariables);
    previousGlobalVariablesRef.current = globalVariables;
    const timerId = setTimeout(() => setChangedVariables([]), ANIMATION_RESET_DELAY_MS);
    return () => clearTimeout(timerId);
  }, [globalVariables, skipAnimation]);

  return (
    <>
      <Stack>
        {linked.map((name, idx) => (
          <LinkedGlobalVariableRow key={`${idx}.${name}`} name={name} />
        ))}
      </Stack>
      {/* <SGlobalVariablesTable>
        <LegacyTable>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Value</th>
              <th>Topic(s)</th>
            </tr>
          </thead>
          <tbody>
            {linked.map((name, idx) => (
              <SAnimatedRow
                key={`linked-${idx}`}
                skipAnimation={skipAnimation.current}
                animate={changedVariables.includes(name)}
              >
                <LinkedGlobalVariableRow name={name} />
              </SAnimatedRow>
            ))}
            {unlinked.map((name, idx) => (
              <SAnimatedRow
                key={`unlinked-${idx}`}
                skipAnimation={skipAnimation.current}
                animate={changedVariables.includes(name)}
              >
                <td data-test="global-variable-key">
                  <ValidatedResizingInput
                    value={name}
                    dataTest={`global-variable-key-input-${name}`}
                    onChange={(newKey) =>
                      changeGlobalKey(
                        newKey,
                        name,
                        globalVariables,
                        linked.length + idx,
                        overwriteGlobalVariables,
                      )
                    }
                    invalidInputs={without(globalVariableNames, name).concat("")}
                  />
                </td>
                <td width="100%">
                  <JSONInput
                    dataTest={`global-variable-value-input-${JSON.stringify(
                      globalVariables[name] ?? "",
                    )}`}
                    value={JSON.stringify(globalVariables[name]) ?? ""}
                    onChange={(newVal) => setGlobalVariables({ [name]: newVal })}
                  />
                </td>
                <td width="100%">
                  <Stack
                    direction="row"
                    flex="auto"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    --
                    <SIconWrapper onClick={() => setGlobalVariables({ [name]: undefined })}>
                      <Icon size="small">
                        <CloseIcon />
                      </Icon>
                    </SIconWrapper>
                  </Stack>
                </td>
              </SAnimatedRow>
            ))}
          </tbody>
        </LegacyTable>
        <Stack direction="row" flex="auto" marginTop={2.5}>
          <DefaultButton
            text="Add variable"
            disabled={globalVariables[""] != undefined}
            onClick={() => setGlobalVariables({ "": "" })}
          />
        </Stack>
      </SGlobalVariablesTable> */}
    </>
  );
}

export default GlobalVariablesTable;
