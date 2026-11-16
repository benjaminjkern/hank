import styled from "styled-components";

// The disclosure caret on every expand/collapse header, chat and panel alike:
// points right while closed, rotates to point down while open. Drawn as an SVG
// centred in its viewBox rather than a "▶" glyph — a glyph sits off-centre in
// its em box, so rotating it pivots around a point that isn't the visible mark
// and the open state looks shifted.
const CaretSvg = styled.svg<{ $open: boolean; $size: number }>`
  width: ${({ $size }) => $size}px;
  height: ${({ $size }) => $size}px;
  display: block;
  flex-shrink: 0;
  color: ${({ theme }) => theme.colors.textSubtle};
  transform: rotate(${({ $open }) => ($open ? "90deg" : "0deg")});
  transition: transform 0.12s ease;
`;

export function Caret({ open, size = 10 }: { open: boolean; size?: number }) {
  return (
    <CaretSvg $open={open} $size={size} viewBox="0 0 10 10" aria-hidden>
      <path d="M2 1.5 L8 5 L2 8.5 Z" fill="currentColor" />
    </CaretSvg>
  );
}
