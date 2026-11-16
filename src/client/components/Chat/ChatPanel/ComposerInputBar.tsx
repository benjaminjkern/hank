import { HankLogo } from "../../HankLogo";

import { HOP_HANK_ANIMATIONS, HopHank } from "./HopHank";
import {
  IconButton,
  Input,
  INPUT_MAX_HEIGHT,
  INPUT_MIN_HEIGHT,
  InputBar,
  InputPod,
  InputWrap,
  Send,
  SendIcon,
  StopButton,
  StopIcon,
} from "./inputBarStyles";

import type { ChangeEvent, KeyboardEvent, RefObject } from "react";

// The input row itself: attach, the autosizing textarea (with the hopping Hank
// while streaming), and Send / Stop. Every piece of state it shows is owned by
// ChatPanel and passed in.
export function ComposerInputBar({
  fileRef,
  onFile,
  inputRef,
  text,
  setText,
  onKey,
  submit,
  stop,
  streaming,
  canChat,
  canSend,
  readOnly,
  anyUploading,
  hasPendingAttachments,
  animIndex,
  animTick,
  pickNextAnim,
}: {
  fileRef: RefObject<HTMLInputElement | null>;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  submit: () => void;
  stop: () => Promise<void>;
  streaming: boolean;
  canChat: boolean;
  canSend: boolean;
  readOnly: boolean;
  anyUploading: boolean;
  hasPendingAttachments: boolean;
  animIndex: number;
  animTick: number;
  pickNextAnim: () => void;
}) {
  return (
    <InputBar>
      <input
        ref={fileRef}
        type="file"
        multiple
        onChange={onFile}
        style={{ display: "none" }}
      />
      <InputPod $thinking={streaming}>
        <IconButton
          onClick={() => fileRef.current?.click()}
          $disabled={streaming || !canChat}
          title={
            readOnly
              ? "Read-only — attachments disabled"
              : "Attach files (PDF, Word .docx, image, or text) — sent when you hit Send"
          }
        >
          📎
        </IconButton>
        <InputWrap>
          <Input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              readOnly
                ? "Read-only — viewing another user's session"
                : streaming
                  ? "Hank is thinking…"
                  : anyUploading
                    ? "Uploading…"
                    : hasPendingAttachments
                      ? "Optionally add a message, then Send…"
                      : "Message Hank…"
            }
            disabled={streaming || !canChat}
            $thinking={streaming}
            rows={1}
            style={{
              minHeight: INPUT_MIN_HEIGHT,
              maxHeight: INPUT_MAX_HEIGHT,
              paddingLeft: streaming ? 38 : undefined,
            }}
          />
          {streaming && (
            <HopHank
              key={animTick}
              aria-hidden
              $anim={HOP_HANK_ANIMATIONS[animIndex]}
              onAnimationEnd={pickNextAnim}
            >
              <HankLogo size={20} />
            </HopHank>
          )}
        </InputWrap>
        {streaming ? (
          <StopButton
            onClick={() => void stop()}
            aria-label="Stop"
            title="Stop Hank"
          >
            <StopIcon viewBox="0 0 14 14" aria-hidden>
              <rect
                x="3"
                y="3"
                width="8"
                height="8"
                rx="1"
                fill="currentColor"
              />
            </StopIcon>
          </StopButton>
        ) : (
          <Send
            onClick={submit}
            $disabled={!canSend}
            aria-label="Send"
            title="Send"
          >
            <SendIcon viewBox="0 0 16 16" aria-hidden>
              <path
                d="M8 13 V3 M3.5 7.5 L8 3 L12.5 7.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </SendIcon>
          </Send>
        )}
      </InputPod>
    </InputBar>
  );
}
