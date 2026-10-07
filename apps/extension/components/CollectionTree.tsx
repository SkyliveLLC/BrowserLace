import { buildTree, type TreeNode } from "@browserlace/core";
import { useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { collectionStateItem } from "../lib/storage.ts";
import { hostname, useStored } from "./ui.tsx";

/** A collection's bookmarks as a collapsible tree, read from local state. Clicking opens a tab. */
export function CollectionTree({ collectionId, name }: { collectionId: string; name: string }) {
  const item = useMemo(() => collectionStateItem(collectionId), [collectionId]);
  const state = useStored(item);
  const tree = useMemo(() => state && buildTree(new Map(Object.entries(state.nodes))), [state]);
  return (
    <Folder node={tree ?? { id: collectionId, title: name, url: null, pos: "", children: [] }} title={name} />
  );
}

function Folder({ node, title }: { node: TreeNode; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button className="item" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="title">{title}</span>
        <span className="host">{node.children.length || ""}</span>
      </button>
      {open && (
        <ul className="list" style={{ paddingLeft: 14 }}>
          {node.children.length === 0 && <li className="muted item">Empty</li>}
          {node.children.map((child) =>
            child.url === null ? (
              <Folder key={child.id} node={child} title={child.title} />
            ) : (
              <li key={child.id}>
                <button className="item" title={child.url} onClick={() => void browser.tabs.create({ url: child.url! })}>
                  <span className="title">{child.title || child.url}</span>
                  <span className="host">{hostname(child.url)}</span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </li>
  );
}
