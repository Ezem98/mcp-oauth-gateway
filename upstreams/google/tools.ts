import { z } from "zod";
import { driveRead, driveSearch } from "./drive.js";
import {
  fetchGoogleAccessToken,
  GatewayTokenError,
  ReconnectRequiredError,
} from "./gateway-token.js";
import { gmailCreateDraft, gmailRead, gmailSearch } from "./gmail.js";
import { GoogleApiError } from "./google-api.js";

const ID_REGEX = /^[A-Za-z0-9_-]{1,256}$/;

const clampMaxResults = z
  .coerce.number()
  .optional()
  .default(10)
  .transform((n) => Math.min(20, Math.max(1, Math.floor(n))));

export const gmailSearchSchema = z
  .object({
    query: z.string().min(1, "query no puede estar vacío"),
    max_results: clampMaxResults,
  })
  .strict();

export const gmailReadSchema = z
  .object({
    message_id: z.string().regex(ID_REGEX, "message_id inválido"),
  })
  .strict();

export const gmailCreateDraftSchema = z
  .object({
    to: z.string().min(1, "to no puede estar vacío"),
    subject: z.string(),
    body: z.string(),
    cc: z.string().optional(),
    reply_to_message_id: z
      .string()
      .regex(ID_REGEX, "reply_to_message_id inválido")
      .optional(),
  })
  .strict();

export const driveSearchSchema = z
  .object({
    query: z.string().min(1, "query no puede estar vacío"),
    max_results: clampMaxResults,
  })
  .strict();

export const driveReadSchema = z
  .object({
    file_id: z.string().regex(ID_REGEX, "file_id inválido"),
  })
  .strict();

export const TOOL_DEFINITIONS = [
  {
    name: "gmail_search",
    description:
      "Buscar correos en Gmail según una consulta de búsqueda y devolver sus metadatos principales.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Consulta de búsqueda para Gmail (ej. 'from:juan@ejemplo.com', 'is:unread')",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 10,
          description: "Cantidad máxima de resultados (1 a 20, por defecto 10)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_read",
    description:
      "Leer el contenido y metadatos de un correo electrónico de Gmail por su ID.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "ID del mensaje en Gmail",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "Crear un borrador de correo en Gmail. Solo crea un borrador y NUNCA envía el correo: revisalo y envialo vos desde Gmail.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Dirección de correo electrónico del destinatario",
        },
        subject: {
          type: "string",
          description: "Asunto del correo",
        },
        body: {
          type: "string",
          description: "Cuerpo del correo en texto plano",
        },
        cc: {
          type: "string",
          description: "Destinatario(s) en copia (CC) opcional",
        },
        reply_to_message_id: {
          type: "string",
          description: "ID del mensaje al cual responder (opcional)",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_search",
    description:
      "Buscar archivos en Google Drive por texto en el contenido o en el nombre.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Texto o término a buscar en Google Drive",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 10,
          description: "Cantidad máxima de resultados (1 a 20, por defecto 10)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_read",
    description:
      "Leer el contenido o metadatos de un archivo en Google Drive por su ID.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "ID del archivo en Google Drive",
        },
      },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
];

export interface CallToolContext {
  gatewayUrl: string;
  serverId: string;
  userToken: string;
  gmailApiBase: string;
  driveApiBase: string;
}

export interface CallToolResult {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  ctx: CallToolContext
): Promise<CallToolResult> {
  const args = rawArgs ?? {};

  let parsedArgs: any;
  switch (name) {
    case "gmail_search": {
      const parsed = gmailSearchSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: parsed.error.message }],
          isError: true,
        };
      }
      parsedArgs = parsed.data;
      break;
    }
    case "gmail_read": {
      const parsed = gmailReadSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: parsed.error.message }],
          isError: true,
        };
      }
      parsedArgs = parsed.data;
      break;
    }
    case "gmail_create_draft": {
      const parsed = gmailCreateDraftSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: parsed.error.message }],
          isError: true,
        };
      }
      parsedArgs = parsed.data;
      break;
    }
    case "drive_search": {
      const parsed = driveSearchSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: parsed.error.message }],
          isError: true,
        };
      }
      parsedArgs = parsed.data;
      break;
    }
    case "drive_read": {
      const parsed = driveReadSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: parsed.error.message }],
          isError: true,
        };
      }
      parsedArgs = parsed.data;
      break;
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }

  try {
    const token = await fetchGoogleAccessToken({
      gatewayUrl: ctx.gatewayUrl,
      serverId: ctx.serverId,
      userToken: ctx.userToken,
    });

    let result: unknown;
    switch (name) {
      case "gmail_search":
        result = await gmailSearch(
          { base: ctx.gmailApiBase, token },
          parsedArgs
        );
        break;
      case "gmail_read":
        result = await gmailRead(
          { base: ctx.gmailApiBase, token },
          parsedArgs
        );
        break;
      case "gmail_create_draft":
        result = await gmailCreateDraft(
          { base: ctx.gmailApiBase, token },
          parsedArgs
        );
        break;
      case "drive_search":
        result = await driveSearch(
          { base: ctx.driveApiBase, token },
          parsedArgs
        );
        break;
      case "drive_read":
        result = await driveRead(
          { base: ctx.driveApiBase, token },
          parsedArgs
        );
        break;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return {
        content: [
          {
            type: "text",
            text: `Hay que reconectar la cuenta de Google: ${err.connectHint}`,
          },
        ],
        isError: true,
      };
    }
    if (err instanceof GoogleApiError) {
      return {
        content: [
          {
            type: "text",
            text: `Error de Google (${err.status}): ${err.message}`,
          },
        ],
        isError: true,
      };
    }
    if (err instanceof GatewayTokenError) {
      return {
        content: [
          {
            type: "text",
            text: `No se pudo obtener el token de Google del gateway (HTTP ${err.status})`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
      isError: true,
    };
  }
}
