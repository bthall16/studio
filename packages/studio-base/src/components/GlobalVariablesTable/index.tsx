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

import { MoreVert } from "@mui/icons-material";
import CloseIcon from "@mui/icons-material/Close";
import {
  Button,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { partition, pick, union, without } from "lodash";
import { useMemo, useCallback, useRef, useEffect, useState } from "react";

import Stack from "@foxglove/studio-base/components/Stack";
import { JSONInput } from "@foxglove/studio-base/components/input/JSONInput";
import { ValidatedResizingInput } from "@foxglove/studio-base/components/input/ValidatedResizingInput";
import useGlobalVariables, {
  GlobalVariables,
} from "@foxglove/studio-base/hooks/useGlobalVariables";
import useLinkedGlobalVariables from "@foxglove/studio-base/panels/ThreeDimensionalViz/Interactions/useLinkedGlobalVariables";

// The minimum amount of time to wait between showing the global variable update animation again
export const ANIMATION_RESET_DELAY_MS = 3000;

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

function LinkedGlobalVariableRow({ name }: { name: string }): JSX.Element {
  const [anchorEl, setAnchorEl] = React.useState<undefined | HTMLElement>(undefined);
  const open = Boolean(anchorEl);

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

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };
  const handleClose = () => {
    setAnchorEl(undefined);
  };

  return (
    <TableRow>
      <TableCell>${name}</TableCell>
      <TableCell padding="none">
        <JSONInput
          value={JSON.stringify(globalVariables[name]) ?? ""}
          onChange={(newVal) => setGlobalVariables({ [name]: newVal })}
        />
      </TableCell>
      <TableCell>
        <Stack direction="row" flex="auto" alignItems="center" justifyContent="space-between">
          <Stack direction="row" flex="auto">
            {linkedTopicPaths.length > 1 && <span>({linkedTopicPaths.length})</span>}
            <Tooltip
              arrow
              title={
                linkedTopicPaths.length > 0 && (
                  <Stack gap={0.5}>
                    <Typography variant="overline" color="text.secondary">
                      {linkedTopicPaths.length} LINKED TOPIC{linkedTopicPaths.length > 1 ? "S" : ""}
                    </Typography>
                    {linkedTopicPaths.map((path) => (
                      <Typography key={path} variant="body2">
                        {path}
                      </Typography>
                    ))}
                  </Stack>
                )
              }
            >
              <Typography noWrap variant="inherit" maxWidth="99.9%">
                {linkedTopicPaths.length > 0 ? <bdi>{linkedTopicPaths.join(", ")}</bdi> : "--"}
              </Typography>
            </Tooltip>
          </Stack>
        </Stack>
      </TableCell>
      <TableCell>
        <IconButton
          id="linked-topics-button"
          aria-controls={open ? "linked-topics-menu" : undefined}
          aria-haspopup="true"
          aria-expanded={open ? "true" : undefined}
          onClick={handleClick}
        >
          <MoreVert fontSize="small" />
        </IconButton>
        <Menu
          id="linked-topics-menu"
          anchorEl={anchorEl}
          open={open}
          onClose={handleClose}
          MenuListProps={{
            "aria-labelledby": "linked-topics-button",
            dense: true,
          }}
        >
          {linkedTopicPaths.map((path) => (
            <MenuItem data-test="unlink-path" key={path} onClick={() => unlink(path)}>
              {`Remove ${path}`}
            </MenuItem>
          ))}
          <Divider />
          <MenuItem
            onClick={() => {
              unlinkAndDelete();
              handleClose();
            }}
          >
            Delete variable
          </MenuItem>
        </Menu>
      </TableCell>
    </TableRow>
  );
}

function GlobalVariablesTable(): JSX.Element {
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
    <Stack gap={1} style={{ marginLeft: -16, marginRight: -16 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Variable</TableCell>
            <TableCell padding="none" width="40%">
              Value
            </TableCell>
            <TableCell>Topic(s)</TableCell>
            <TableCell>&nbsp;</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {linked.map((name, idx) => (
            <LinkedGlobalVariableRow key={`linked-${idx}`} name={name} />
          ))}
          {unlinked.map((name, idx) => (
            <TableRow key={`unlinked-${idx}`} selected={changedVariables.includes(name)}>
              <TableCell data-test="global-variable-key">
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
              </TableCell>
              <TableCell padding="none">
                <JSONInput
                  dataTest={`global-variable-value-input-${JSON.stringify(
                    globalVariables[name] ?? "",
                  )}`}
                  value={JSON.stringify(globalVariables[name]) ?? ""}
                  onChange={(newVal) => setGlobalVariables({ [name]: newVal })}
                />
              </TableCell>
              <TableCell>
                <Stack
                  direction="row"
                  flex="auto"
                  alignItems="center"
                  justifyContent="space-between"
                  gap={1}
                >
                  --
                </Stack>
              </TableCell>
              <TableCell>
                <IconButton onClick={() => setGlobalVariables({ [name]: undefined })}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Stack direction="row" flex="auto">
        <Button
          variant="outlined"
          color="inherit"
          disabled={globalVariables[""] != undefined}
          onClick={() => setGlobalVariables({ "": "" })}
        >
          Add variable
        </Button>
      </Stack>
    </Stack>
  );
}

export default GlobalVariablesTable;
