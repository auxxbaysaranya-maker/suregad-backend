declare module "http" {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

export interface AuthUser {
  _id: { toString(): string };
  roles: string[];
  email?: string | null;
  phone?: string | null;
  displayName?: string;
  status?: string;
  employeeGrants?: { businessId?: unknown; permissions?: string[] }[];
  tokenValidAfter?: Date | null;
  save?: () => Promise<unknown>;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      permissions?: Set<string>;
      rawBody?: Buffer;
    }
  }
}

export {};
