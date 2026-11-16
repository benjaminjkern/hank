import { NEGOTIATION_PANELS, type NegotiationPanel } from "@/shared/panelMode";

import {
  AttachmentRow,
  ChipClose,
  ChipConfirm,
  PendingChip,
  PendingName,
} from "./composerChipStyles";
import { PANEL_CHIP, panelEditCount, panelEditLabel } from "./panelEditLabels";

// One chip per negotiation panel with unsent changes, above the composer. The
// arm-then-confirm `discarding` state lives in ChatPanel; this only renders it.
export function PanelEditChips({
  pendingPanelEdits,
  panelScope,
  discarding,
  setDiscarding,
  discardPanelEdits,
}: {
  pendingPanelEdits: Record<NegotiationPanel, number>;
  panelScope: Record<NegotiationPanel, string | null>;
  discarding: NegotiationPanel | null;
  setDiscarding: (panel: NegotiationPanel | null) => void;
  discardPanelEdits: (panel: NegotiationPanel) => Promise<void>;
}) {
  return (
    <>
      {NEGOTIATION_PANELS.filter((p) => pendingPanelEdits[p] > 0).map(
        (panel) => (
          <AttachmentRow key={panel}>
            {/* The changes are already saved on the panel; the server attaches
                them to whatever the user sends next. Dismissing UNDOES them —
                see discardPanelEdits. */}
            <PendingChip
              $status="uploaded"
              title="Send a message and Hank picks these up. The × throws them away."
            >
              {PANEL_CHIP[panel].icon}{" "}
              <PendingName>
                {discarding === panel
                  ? `Discard ${panelEditCount(panel, pendingPanelEdits[panel])}?`
                  : panelEditLabel(
                      panel,
                      pendingPanelEdits[panel],
                      panelScope[panel],
                    )}
              </PendingName>
              {discarding === panel ? (
                <>
                  <ChipConfirm
                    onClick={() => {
                      setDiscarding(null);
                      void discardPanelEdits(panel);
                    }}
                  >
                    Discard
                  </ChipConfirm>
                  <ChipClose
                    onClick={() => setDiscarding(null)}
                    aria-label={`keep my ${PANEL_CHIP[panel].noun} changes`}
                  >
                    ×
                  </ChipClose>
                </>
              ) : (
                <ChipClose
                  onClick={() => setDiscarding(panel)}
                  aria-label={`discard my ${PANEL_CHIP[panel].noun} changes`}
                  title="Discard these changes — this panel goes back to what Hank last saw"
                >
                  ×
                </ChipClose>
              )}
            </PendingChip>
          </AttachmentRow>
        ),
      )}
    </>
  );
}
