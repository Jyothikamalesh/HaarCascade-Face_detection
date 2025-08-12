import * as vscode from 'vscode';

interface ConfluenceAuth {
  token: string;
  url: string;
  email: string;
}

interface ConfluenceSpace {
  key: string;
  name: string;
}

interface ConfluencePageContent {
  id: string;
  title: string;
  version: { number: number };
  space: { key: string; name?: string };
  body: { storage: { value: string } };
  _links: { webui: string };
}

let confluenceAuth: ConfluenceAuth | null = null;

const INSTRUCTIONS = `You are KB Agent, an AI assistant integrated into VS Code.
Provide helpful, concise responses, and support special '@kb_agent /auth', '@kb_agent /pages', '@kb_agent /page', '@kb_agent /update', and '@kb_agent /create' commands for Confluence integration.`;

function normalizePrompt(input: string): string {
  const raw = input ?? '';
  const linkMatch = raw.trim().match(/^\[([^\]]+)\]\([^\)]*\)$/);
  if (linkMatch) {
    return linkMatch[1].trim();
  }
  return raw.trim();
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "kb_agent" is now active.');

  const saved = context.globalState.get<ConfluenceAuth>('kbAgentAuth');
  confluenceAuth = saved ?? null;

  async function saveAuth(auth: ConfluenceAuth) {
    await context.globalState.update('kbAgentAuth', auth);
    confluenceAuth = auth;
  }

  async function makeConfluenceRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
    if (!confluenceAuth) throw new Error('Not authenticated. Please run @kb_agent /auth first.');
    const url = `${confluenceAuth.url}/wiki/rest/api${endpoint}`;
    const authHeader = Buffer.from(`${confluenceAuth.email}:${confluenceAuth.token}`).toString('base64');
    const merged: RequestInit = {
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      },
      ...options
    };
    if (merged.body && typeof merged.body === 'object') {
      merged.body = JSON.stringify(merged.body);
    }
    const response = await fetch(url, merged);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response.json();
  }

  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    if (!confluenceAuth) {
      const s = context.globalState.get<ConfluenceAuth>('kbAgentAuth');
      if (s) confluenceAuth = s;
    }

    const original = request.prompt ?? '';
    const prompt = normalizePrompt(original);
    const prefix = '@kb_agent ';
    const isCommand = prompt.startsWith(prefix);

    if (!isCommand) {
      const [chatModel] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
      if (!chatModel) return stream.markdown('No Copilot model available.');
      const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(INSTRUCTIONS)];
      for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p) => p instanceof vscode.ChatResponseMarkdownPart)
            .map((p) => (p as vscode.ChatResponseMarkdownPart).value.value)
            .join('\n');
          if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
      messages.push(vscode.LanguageModelChatMessage.User(original));
      const chatResponse = await chatModel.sendRequest(messages, {}, token);
      for await (const part of chatResponse.text) stream.markdown(part);
      return;
    }

    const rest = prompt.slice(prefix.length).trim();

    // --- AUTH ---
    if (rest.startsWith('/auth')) {
      const jsonText = rest.replace('/auth', '').trim();
      try {
        const data = JSON.parse(jsonText);
        if (!data.token || !data.url || !data.email) {
          return stream.markdown('❌ Missing fields: token, url, email.');
        }
        data.url = String(data.url).replace(/\/$/, '');
        const auth: ConfluenceAuth = { token: String(data.token), url: String(data.url), email: String(data.email) };
        try {
          await makeConfluenceRequest('/space');
          await saveAuth(auth);
          return stream.markdown('✅ **Authenticated!** You can now use `/pages`, `/page`, `/update`, `/create`.');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return stream.markdown(`❌ Auth failed: ${msg}`);
        }
      } catch {
        return stream.markdown('❌ Invalid JSON for authentication.');
      }
    }

    if (!confluenceAuth) {
      return stream.markdown('❌ Not authenticated. Run `/auth` first.');
    }

    // // --- /pages ---
    // if (rest === '/pages') {
    //   try {
    //     const spaces = await makeConfluenceRequest('/space?limit=50') as { results: ConfluenceSpace[] };
    //     let output = '📚 **Page Titles from all accessible spaces:**\n\n';
    //     let totalPages = 0;
    //     for (const space of spaces.results) {
    //       const encodedKey = encodeURIComponent(space.key);
    //       const pagesResponse = await makeConfluenceRequest(
    //         `/space/${encodedKey}/content/page?limit=100&status=current`
    //       ) as ConfluencePagesResponse;
    //       if (pagesResponse.results.length > 0) {
    //         output += `**Space: ${space.name} (${space.key})**\n`;
    //         for (const page of pagesResponse.results) {
    //           const pageUrl = `${confluenceAuth.url}/wiki${page._links.webui}`;
    //           output += `- [${page.title}](${pageUrl}) (ID: ${page.id})\n`;
    //           totalPages++;
    //         }
    //         output += '\n';
    //       }
    //     }
    //     if (totalPages === 0) return stream.markdown('📄 No pages found.');
    //     output += `---\n**Total: ${totalPages} pages found**`;
    //     return stream.markdown(output);
    //   } catch (err) {
    //     return stream.markdown(`❌ Failed to read pages: ${err instanceof Error ? err.message : err}`);
    //   }
    // }

    // --- /page <pageId> ---
    if (rest.startsWith('/page')) {
      const parts = rest.split(' ').filter(Boolean);
      if (parts.length < 2) return stream.markdown('❌ Usage: `/page <pageId>`');
      const pageId = parts[1];
      try {
        const page = await makeConfluenceRequest(
          `/content/${pageId}?expand=body.storage,version,space`
        ) as ConfluencePageContent;
        let output = `### 📄 Page: ${page.title}\n`;
        output += `- ID: ${page.id}\n`;
        output += `- Space: ${page.space.key}\n`;
        output += `- Version: ${page.version.number}\n`;
        output += `- URL: ${confluenceAuth.url}/wiki${page._links.webui}\n\n`;
        output += `**Content:**\n\n${page.body.storage.value}`;
        return stream.markdown(output);
      } catch (err) {
        return stream.markdown(`❌ Failed to fetch page: ${err instanceof Error ? err.message : err}`);
      }
    }

    // --- /update <pageId> <text to append> ---
    if (rest.startsWith('/update')) {
      const firstSpace = rest.indexOf(' ');
      if (firstSpace === -1) return stream.markdown('❌ Usage: `/update <pageId> <message to append>`');
      const afterCmd = rest.slice(firstSpace).trim();
      const secondSpace = afterCmd.indexOf(' ');
      if (secondSpace === -1) return stream.markdown('❌ Missing message to append.');
      const pageId = afterCmd.slice(0, secondSpace).trim();
      const messageToAppend = afterCmd.slice(secondSpace).trim();
      try {
        const page = await makeConfluenceRequest(
          `/content/${pageId}?expand=body.storage,version,space`
        ) as ConfluencePageContent;
        const newContent = page.body.storage.value + `<p>${messageToAppend}</p>`;
        const payload = {
          id: pageId,
          type: 'page',
          title: page.title,
          space: { key: page.space.key },
          body: {
            storage: {
              value: newContent,
              representation: 'storage'
            }
          },
          version: { number: page.version.number + 1 }
        };
        await makeConfluenceRequest(`/content/${pageId}`, { method: 'PUT', body: payload });
        return stream.markdown(`✅ Appended content to [${page.title}](${confluenceAuth.url}/wiki${page._links.webui})`);
      } catch (err) {
        return stream.markdown(`❌ Failed to update page: ${err instanceof Error ? err.message : err}`);
      }
    }

    // --- /create remains same ---
    // if (rest.startsWith('/create')) {
    //   const jsonText = rest.replace('/create', '').trim();
    //   try {
    //     const pd = JSON.parse(jsonText);
    //     if (!pd.spaceKey || !pd.title || !pd.content) {
    //       return stream.markdown('❌ Missing: spaceKey, title, content.');
    //     }
    //     const payload: any = {
    //       type: 'page',
    //       title: String(pd.title),
    //       space: { key: String(pd.spaceKey) },
    //       body: { storage: { value: String(pd.content), representation: 'storage' } },
    //     };
    //     if (pd.parentId) payload.ancestors = [{ id: String(pd.parentId) }];
    //     const created = await makeConfluenceRequest('/content', { method: 'POST', body: payload }) as ConfluenceCreatePageResponse;
    //     const url = `${confluenceAuth.url}/wiki${created._links.webui}`;
    //     return stream.markdown(`✅ Page created: [${created.title}](${url})`);
    //   } catch (err) {
    //     const msg = err instanceof Error ? err.message : String(err);
    //     if (msg.includes('JSON')) return stream.markdown('❌ Invalid JSON format for page data.');
    //     return stream.markdown(`❌ Create failed: ${msg}`);
    //   }
    // }

    return stream.markdown('❌ Unknown command. Use `/auth`, `/pages`, `/page <id>`, `/update <id> <text>`, or `/create`.');
  };

  context.subscriptions.push(vscode.chat.createChatParticipant('kb-agent', handler));
}

export function deactivate() {}
