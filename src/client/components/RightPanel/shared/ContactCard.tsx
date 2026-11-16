"use client";

import styled from "styled-components";

import type { ContactView } from "@/server/agent/tools/lib/types";

// One person, rendered the same way wherever they surface — the opportunity
// detail page (recruiters on an inbound lead) and the company page (in-house
// contacts, linked by Contact.companyId). Owns only the row; the parent
// supplies the Card chrome and the heading.
//
// Rows separate themselves with a dashed rule, so a list is just N of these
// with no wrapper — the last one drops its own border.

const ContactRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: ${({ theme }) => `${theme.space.sm} 0`};
  border-bottom: 1px dashed ${({ theme }) => theme.colors.border};
  &:last-child {
    border-bottom: none;
  }
`;

const ContactName = styled.div`
  font-size: 14px;
  font-weight: 500;
  color: ${({ theme }) => theme.colors.text};
`;

const ContactMeta = styled.div`
  font-size: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
`;

const ContactLinks = styled.div`
  display: flex;
  gap: ${({ theme }) => theme.space.sm};
  font-size: 12px;
  margin-top: 2px;
`;

const LinkA = styled.a`
  color: ${({ theme }) => theme.colors.accent};
  &:hover {
    text-decoration: underline;
  }
`;

export function ContactCard({ contact }: { contact: ContactView }) {
  const subLineParts: string[] = [];
  if (contact.role) subLineParts.push(contact.role);
  if (contact.agency) subLineParts.push(`@ ${contact.agency}`);
  if (contact.channel) subLineParts.push(`via ${contact.channel}`);

  return (
    <ContactRow>
      <ContactName>{contact.name}</ContactName>
      {subLineParts.length > 0 && (
        <ContactMeta>{subLineParts.join(" · ")}</ContactMeta>
      )}
      {(contact.email || contact.phone || contact.linkedinUrl) && (
        <ContactLinks>
          {contact.email && (
            <LinkA href={`mailto:${contact.email}`}>{contact.email}</LinkA>
          )}
          {contact.phone && (
            <LinkA href={`tel:${contact.phone}`}>{contact.phone}</LinkA>
          )}
          {contact.linkedinUrl && (
            <LinkA href={contact.linkedinUrl} target="_blank" rel="noreferrer">
              LinkedIn
            </LinkA>
          )}
        </ContactLinks>
      )}
      {contact.notes && <ContactMeta>{contact.notes}</ContactMeta>}
    </ContactRow>
  );
}
