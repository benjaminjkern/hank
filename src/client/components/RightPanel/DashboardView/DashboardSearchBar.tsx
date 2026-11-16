import styled from "styled-components";

const SearchBar = styled.div`
  position: relative;
  margin-bottom: ${({ theme }) => theme.space.lg};
`;

const SearchInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  padding: ${({ theme }) => `${theme.space.sm} ${theme.space.xl}`};
  font-size: 14px;
  font-family: inherit;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.bgPanel};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  outline: none;
  transition: border-color 0.12s ease;

  &::placeholder {
    color: ${({ theme }) => theme.colors.textSubtle};
  }
  &:focus {
    border-color: ${({ theme }) => theme.colors.accent};
  }
`;

const SearchIcon = styled.svg`
  position: absolute;
  left: ${({ theme }) => theme.space.sm};
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: ${({ theme }) => theme.colors.textSubtle};
  pointer-events: none;
`;

const ClearButton = styled.button`
  position: absolute;
  right: ${({ theme }) => theme.space.xs};
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  &:hover {
    background: ${({ theme }) => theme.colors.bgHover};
    color: ${({ theme }) => theme.colors.text};
  }
`;

// Escape and the × button both clear the query.
export function DashboardSearchBar({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  return (
    <SearchBar>
      <SearchIcon viewBox="0 0 16 16" aria-hidden>
        <path
          d="M7 1.5a5.5 5.5 0 1 0 3.4 9.83l3.13 3.14a.75.75 0 1 0 1.06-1.06l-3.14-3.13A5.5 5.5 0 0 0 7 1.5Zm-4 5.5a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z"
          fill="currentColor"
        />
      </SearchIcon>
      <SearchInput
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onQueryChange("");
        }}
        placeholder="Search companies & jobs…"
        aria-label="Search companies and jobs"
        autoComplete="off"
        spellCheck={false}
      />
      {query && (
        <ClearButton
          type="button"
          onClick={() => onQueryChange("")}
          aria-label="Clear search"
        >
          ×
        </ClearButton>
      )}
    </SearchBar>
  );
}
