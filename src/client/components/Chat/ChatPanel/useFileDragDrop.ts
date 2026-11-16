import { useState, type DragEvent } from "react";

function isFileDrag(e: DragEvent<HTMLDivElement>): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

// Drop-files-anywhere-on-the-chat. `dragDepth` counts nested enter/leave pairs
// so the overlay doesn't flicker as the drag crosses child elements; it's > 0
// exactly while a file drag is over the panel.
export function useFileDragDrop(stageFiles: (files: File[]) => void) {
  const [dragDepth, setDragDepth] = useState(0);

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    setDragDepth((d) => Math.max(0, d - 1));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) stageFiles(files);
  }

  return { dragDepth, onDragEnter, onDragOver, onDragLeave, onDrop };
}
