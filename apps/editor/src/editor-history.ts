export type HistoryEntry = {
  label: string;
  undo: () => void;
  redo: () => void;
};

export class EditorHistory extends EventTarget {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  readonly maxEntries: number;

  constructor(maxEntries = 200) {
    super();
    this.maxEntries = maxEntries;
  }

  execute(entry: HistoryEntry) {
    entry.redo();
    this.pushApplied(entry);
  }

  pushApplied(entry: HistoryEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
    this.redoStack.length = 0;
    this.changed();
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    entry.undo();
    this.redoStack.push(entry);
    this.changed();
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    entry.redo();
    this.undoStack.push(entry);
    this.changed();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ''; }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }
}
