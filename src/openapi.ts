import { sortObjectKeys, isRefObject, isPlainObject, removeEmptyObjects, createRefObject } from "./utils";
import { AsyncAPIDocument, ConvertOpenAPIFunction, ConvertOptions, OpenAPIDocument } from "./interfaces";

export const converters: Record<string, ConvertOpenAPIFunction > = {
  'openapi': from_openapi_to_asyncapi,
}

function from_openapi_to_asyncapi(openapi: OpenAPIDocument, options: ConvertOptions={}): AsyncAPIDocument {
  const perspective = options.v2tov3?.pointOfView === 'client' ? 'client' : 'server';
  const asyncapi: Partial<AsyncAPIDocument> = {
      asyncapi: '3.0.0',
      info: convertInfoObject(openapi.info, openapi),
      servers: openapi.servers ? convertServerObjects(openapi.servers, openapi) : undefined,
      channels: {},
      operations: {},
      components: convertComponents(openapi)
  };

  const { channels, operations } = convertPaths(openapi.paths, perspective);
  asyncapi.channels = channels;
  asyncapi.operations = operations;

  removeEmptyObjects(asyncapi);

  return sortObjectKeys(
      asyncapi as AsyncAPIDocument,
      ['asyncapi', 'info', 'defaultContentType', 'servers', 'channels', 'operations', 'components']
  );
}

interface InfoObject {
  title: string;
  version: string;
  description?: string;
  termsOfService?: string;
  contact?: ContactObject;
  license?: LicenseObject;
}

interface ContactObject {
  name?: string;
  url?: string;
  email?: string;
}

interface LicenseObject {
  name: string;
  url?: string;
}

function convertInfoObject(info: InfoObject, openapi: OpenAPIDocument): AsyncAPIDocument['info'] {
  return sortObjectKeys({
      ...info,
      tags: [openapi.tags],
      externalDocs: openapi.externalDocs,
  }, [
      "title",
      "version",
      "description",
      "termsOfService",
      "contact",
      "license",
      "tags",
      "externalDocs",
  ]);
}

interface ServerObject {
  url: string;
  description?: string;
  variables?: Record<string, ServerVariableObject>;
}

interface ServerVariableObject {
  enum?: string[];
  default: string;
  description?: string;
}


function convertServerObjects(servers: ServerVariableObject[], openapi: OpenAPIDocument): AsyncAPIDocument['servers'] {
  const newServers: Record<string, any> = {};
  const security: Record<string, any> = openapi.security;
  Object.entries(servers).forEach(([index, server]: [string, any]) => {
    
    const serverName = generateServerName(server.url);
    if (isRefObject(server)) {
      newServers[serverName] = server;
      return;
    }

    const { host, pathname, protocol } = resolveServerUrl(server.url);
    server.host = host;
    if (pathname !== undefined) {
      server.pathname = pathname;
    }

    if (protocol !== undefined && server.protocol === undefined) {
      server.protocol = protocol;
    }
    delete server.url;

    if (security) {
      server.security = security.map((securityRequirement: Record<string, any>) => {
        // pass through the security requirement, conversion will happen in components
        return securityRequirement;
      });
      delete openapi.security;
    }

      newServers[serverName] = sortObjectKeys(
        server,
        ['host', 'pathname', 'protocol', 'protocolVersion', 'title', 'summary', 'description', 'variables', 'security', 'tags', 'externalDocs', 'bindings'],
      );
    });

    return newServers;
}

function generateServerName(url: string): string {
  const { host, pathname } = resolveServerUrl(url);
  const baseName = host.split('.').slice(-2).join('.');
  const pathSegment = pathname ? pathname.split('/')[1] : ''; 
  return `${baseName}${pathSegment ? `_${pathSegment}` : ''}`.replace(/[^a-zA-Z0-9_]/g, '_'); 
}

function resolveServerUrl(url: string): {
  host: string;
  pathname?: string;
  protocol: string;
} {
  let [maybeProtocol, maybeHost] = url.split("://");
  if (!maybeHost) {
      maybeHost = maybeProtocol;
  }
  const [host, ...pathnames] = maybeHost.split("/");

  if (pathnames.length) {
      return {
          host,
          pathname: `/${pathnames.join("/")}`,
          protocol: maybeProtocol,
      };
  }
  return { host, pathname: undefined , protocol: maybeProtocol };
}

function convertPaths(paths: OpenAPIDocument['paths'], perspective: 'client' | 'server'): { 
  channels: AsyncAPIDocument['channels'], 
  operations: AsyncAPIDocument['operations'] 
} {
  const channels: AsyncAPIDocument['channels'] = {};
  const operations: AsyncAPIDocument['operations'] = {};

  for (const [path, pathItemOrRef] of Object.entries(paths)) {
    if (!isPlainObject(pathItemOrRef)) continue;

    const pathItem = isRefObject(pathItemOrRef) ? pathItemOrRef : pathItemOrRef as any;
    const channelName = path.replace(/^\//, '').replace(/\//g, '_') || 'root';
    channels[channelName] = {
      address: path,
      messages: {},
      parameters: convertPathParameters(pathItem.parameters)
    };

    for (const [method, operation] of Object.entries(pathItem)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(method) && isPlainObject(operation)) {
        const operationObject = operation as any;
        const operationId = operationObject.operationId || `${method}${channelName}`;

        // Convert request body to message
        if (operationObject.requestBody) {
          const requestMessages = convertRequestBodyToMessages(operationObject.requestBody, operationId, method);
          Object.assign(channels[channelName].messages, requestMessages);
        }

        // Convert responses to messages
        if (operationObject.responses) {
          const responseMessages = convertResponsesToMessages(operationObject.responses, operationId, method);
          Object.assign(channels[channelName].messages, responseMessages);
        }

        // Create operation
        operations[operationId] = {
          action: perspective === 'client' ? 'send' : 'receive',
          channel: createRefObject('channels', channelName),
          summary: operationObject.summary,
          description: operationObject.description,
          tags: operationObject.tags?.map((tag: string) => ({ name: tag })),
          bindings: {
            http: {
              method: method.toUpperCase(),
            }
          },
          messages: Object.keys(channels[channelName].messages)
            .filter(messageName => messageName.startsWith(operationId))
            .map(messageName => createRefObject('channels', channelName, 'messages', messageName))
        };

        // Convert parameters
        if (operationObject.parameters) {
          const params = convertOperationParameters(operationObject.parameters);
          if (Object.keys(params).length > 0) {
            channels[channelName].parameters = {
              ...channels[channelName].parameters,
              ...params
            };
          }
        }
      }
    }

    removeEmptyObjects(channels[channelName]);
  }

  return { channels, operations };
}

function convertPathParameters(parameters: any[] = []): Record<string, any> {
  const convertedParams: Record<string, any> = {};
  
  parameters.forEach(param => {
    if (param.in === 'path') {
      convertedParams[param.name] = {
        description: param.description,
        schema: convertSchema(param.schema)
      };
    }
  });

  return convertedParams;
}

function convertOperationParameters(parameters: any[]): Record<string, any> {
  const convertedParams: Record<string, any> = {};
  
  parameters.forEach(param => {
    if (param.in === 'query') {
      convertedParams[param.name] = {
        description: param.description,
        schema: convertSchema(param.schema)
      };
    }
  });

  return convertedParams;
}

function convertRequestBodyToMessages(requestBody: any, operationId: string, method: string): Record<string, any> {
  const messages: Record<string, any> = {};

  if (isPlainObject(requestBody.content)) {
    Object.entries(requestBody.content).forEach(([contentType, mediaType]: [string, any]) => {
      const messageName = `${operationId}Request`;
      messages[messageName] = {
        name: messageName,
        title: `${method.toUpperCase()} request`,
        contentType: contentType,
        payload: convertSchema(mediaType.schema),
        summary: requestBody.description,
      };
    });
  }

  return messages;
}

function convertResponsesToMessages(responses: Record<string, any>, operationId: string, method: string): Record<string, any> {
  const messages: Record<string, any> = {};

  Object.entries(responses).forEach(([statusCode, response]) => {
    if (isPlainObject(response.content)) {
      Object.entries(response.content).forEach(([contentType, mediaType]: [string, any]) => {
        const messageName = `${operationId}Response${statusCode}`;
        messages[messageName] = {
          name: messageName,
          title: `${method.toUpperCase()} response ${statusCode}`,
          contentType: contentType,
          payload: convertSchema(mediaType.schema),
          summary: response.description,
          headers: response.headers ? convertHeadersToSchema(response.headers) : undefined,
        };
      });
    } else {
      const messageName = `${operationId}Response${statusCode}`;
      messages[messageName] = {
        name: messageName,
        title: `${method.toUpperCase()} response ${statusCode}`,
        summary: response.description,
      };
    }
  });

  return messages;
}

function convertComponents(openapi: OpenAPIDocument): AsyncAPIDocument['components'] {
  const asyncComponents: AsyncAPIDocument['components'] = {};

  if (openapi.components) {
    if (openapi.components.schemas) {
      asyncComponents.schemas = convertSchemas(openapi.components.schemas);
    }

    if (openapi.components.securitySchemes) {
      asyncComponents.securitySchemes = convertSecuritySchemes(openapi.components.securitySchemes);
    }

    if (openapi.components.parameters) {
      asyncComponents.parameters = convertParameters(openapi.components.parameters);
    }

    if (openapi.components.responses) {
      asyncComponents.messages = convertComponentResponsesToMessages(openapi.components.responses);
    }

    if (openapi.components.requestBodies) {
      asyncComponents.messageTraits = convertRequestBodiesToMessageTraits(openapi.components.requestBodies);
    }

    if (openapi.components.headers) {
      asyncComponents.messageTraits = {
        ...(asyncComponents.messageTraits || {}),
        ...convertHeadersToMessageTraits(openapi.components.headers)
      };
    }

    if (openapi.components.examples) {
      asyncComponents.examples = openapi.components.examples;  
    }
  }

  return removeEmptyObjects(asyncComponents);
}

function convertSchemas(schemas: Record<string, any>): Record<string, any> {
  const convertedSchemas: Record<string, any> = {};

  for (const [name, schema] of Object.entries(schemas)) {
    convertedSchemas[name] = convertSchema(schema);
  }

  return convertedSchemas;
}

function convertSchema(schema: any): any {
  if (isRefObject(schema)) {
    return schema;
  }

  const convertedSchema: any = { ...schema };

  if (schema.properties) {
    convertedSchema.properties = {};
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      convertedSchema.properties[propName] = convertSchema(propSchema);
    }
  }

  if (schema.items) {
    convertedSchema.items = convertSchema(schema.items);
  }

  ['allOf', 'anyOf', 'oneOf'].forEach(key => {
    if (schema[key]) {
      convertedSchema[key] = schema[key].map(convertSchema);
    }
  });

  // Handle formats
  if (schema.format === 'date-time') {
    convertedSchema.format = 'date-time';
  } else if (schema.format === 'byte' || schema.format === 'binary') {
    delete convertedSchema.format;
  }

  return convertedSchema;
}

interface SecuritySchemeObject {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: Record<string, OAuthFlowObject>;
  openIdConnectUrl?: string;
}

interface OAuthFlowObject {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

function convertSecuritySchemes(securitySchemes: Record<string, any>): Record<string, any> {
  const convertedSchemes: Record<string, any> = {};

  for (const [name, scheme] of Object.entries(securitySchemes)) {
    convertedSchemes[name] = convertSecurityScheme(scheme);
  }

  return convertedSchemes;
}



function convertSecurityScheme(scheme: SecuritySchemeObject): any {
  const convertedScheme: any = { ...scheme };

  if (scheme.type === 'oauth2' && scheme.flows) {
    convertedScheme.flows = {};
    for (const [flowType, flow] of Object.entries(scheme.flows)) {
      if (isPlainObject(flow)) {
        convertedScheme.flows[flowType] = convertOAuthFlow(flow);
      }
    }
  }

  if (scheme.type === 'http') {
    if (scheme.scheme === 'basic') {
      convertedScheme.type = 'userPassword';
    } else if (scheme.scheme === 'bearer') {
      convertedScheme.type = 'httpBearerToken';
    }
  }

  if (scheme.type === 'apiKey') {
    convertedScheme.type = 'httpApiKey';
  }

  return convertedScheme;
}

function convertOAuthFlow(flow: OAuthFlowObject): any {
  return {
    ...flow,
    availableScopes: flow.scopes || {},
    scopes: undefined,
  };
}

function convertParameters(parameters: Record<string, any>): Record<string, any> {
  const convertedParameters: Record<string, any> = {};

  for (const [name, parameter] of Object.entries(parameters)) {
    if (parameter.in === 'query' || parameter.in === 'path') {
      convertedParameters[name] = {
        ...parameter,
        schema: parameter.schema ? convertSchema(parameter.schema) : undefined,
      };
      delete convertedParameters[name].in;
    }
  }

  return convertedParameters;
}

function convertComponentResponsesToMessages(responses: Record<string, any>): Record<string, any> {
  const messages: Record<string, any> = {};

  for (const [name, response] of Object.entries(responses)) {
    if (isPlainObject(response.content)) {
      Object.entries(response.content).forEach(([contentType, mediaType]: [string, any]) => {
        messages[name] = {
          name: name,
          contentType: contentType,
          payload: convertSchema(mediaType.schema),
          summary: response.description,
          headers: response.headers ? convertHeadersToSchema(response.headers) : undefined,
        };
      });
    } else {
      messages[name] = {
        name: name,
        summary: response.description,
      };
    }
  }

  return messages;
}

function convertRequestBodiesToMessageTraits(requestBodies: Record<string, any>): Record<string, any> {
  const messageTraits: Record<string, any> = {};

  for (const [name, requestBody] of Object.entries(requestBodies)) {
    if (requestBody.content) {
      const contentType = Object.keys(requestBody.content)[0];
      messageTraits[name] = {
        name: name,
        summary: requestBody.description,
        contentType: contentType,
        payload: convertSchema(requestBody.content[contentType].schema),
      };
    }
  }

  return messageTraits;
}

function convertHeadersToMessageTraits(headers: Record<string, any>): Record<string, any> {
  const messageTraits: Record<string, any> = {};

  for (const [name, header] of Object.entries(headers)) {
    messageTraits[`Header${name}`] = {
      headers: {
        type: 'object',
        properties: {
          [name]: convertSchema(header.schema),
        },
        required: [name],
      },
    };
  }

  return messageTraits;
}

function convertHeadersToSchema(headers: Record<string, any>): any {
  const properties: Record<string, any> = {};

  for (const [name, header] of Object.entries(headers)) {
    properties[name] = convertSchema(header.schema);
  }

  return {
    type: 'object',
    properties,
  };
}