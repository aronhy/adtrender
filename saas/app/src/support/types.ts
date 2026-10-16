/** Customer-visible support history. No other member identity or private file data. */
export type OrganizationSupportRequestView = {
  id: string;
  category: string;
  subject: string;
  body: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  organization: { id: string; name: string };
  workspace: { id: string; name: string } | null;
};
