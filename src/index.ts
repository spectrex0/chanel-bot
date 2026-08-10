import "dotenv/config";
import express, { type Request, type Response } from "express";
import {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  Events,
  Interaction,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnection,
  VoiceConnectionState,
} from "@discordjs/voice";
import { Readable } from "stream";
import { existsSync, readFileSync, writeFileSync } from "fs";

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function createSilenceStream() {
  const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
  const silenceStream = new Readable({
    read() {
      this.push(SILENCE_FRAME);
    },
  });
  return silenceStream;
}

const audioPlayer = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Pause,
  },
});

const RECONNECT_DELAY_MS = 30_000;
const VOICE_TARGET_FILE = ".voice-target.json";

let lastGuildId: string | null = null;
let lastChannelId: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function loadVoiceTarget() {
  try {
    if (existsSync(VOICE_TARGET_FILE)) {
      const data = JSON.parse(readFileSync(VOICE_TARGET_FILE, "utf8"));
      if (typeof data.guildId === "string" && typeof data.channelId === "string") {
        lastGuildId = data.guildId;
        lastChannelId = data.channelId;
        console.log(`[VOICE] Objetivo restaurado: ${lastChannelId}`);
      }
    }
  } catch (error) {
    console.error("[VOICE] No se pudo leer la persistencia:", error);
  }
}

function saveVoiceTarget() {
  try {
    writeFileSync(VOICE_TARGET_FILE, JSON.stringify({ guildId: lastGuildId, channelId: lastChannelId }));
  } catch (error) {
    console.error("[VOICE] No se pudo guardar la persistencia:", error);
  }
}

loadVoiceTarget();

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureVoiceConnected();
  }, RECONNECT_DELAY_MS);
}

async function connectToVoice(guildId: string, channelId: string): Promise<VoiceConnection> {
  const guild = bot.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Gremio no encontrado (guildId=${guildId})`);

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased?.()) {
    throw new Error(`El canal no existe o no es de voz (channelId=${channelId})`);
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true,
  });

  connection.on("error", (error) => {
    console.error("[VOICE] Error en la conexión:", error);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    connection.destroy();
    throw error;
  }

  const resource = createAudioResource(createSilenceStream(), {
    inputType: StreamType.Raw,
  });
  audioPlayer.play(resource);
  connection.subscribe(audioPlayer);

  connection.on(
    VoiceConnectionStatus.Disconnected,
    async (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
      console.log(`[VOICE] ⚠️ Desconectado (${oldState.status} -> ${newState.status}). Intentando recuperar...`);
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log(`[VOICE] Reconectando...`);
      } catch {
        console.log(`[VOICE] ❌ No se pudo recuperar la conexión.`);
        connection.destroy();
        scheduleReconnect();
      }
    },
  );

  console.log(`[JOIN] Conectado a: ${channel.name} (${channel.id})`);
  return connection;
}

async function ensureVoiceConnected(guildId = lastGuildId, channelId = lastChannelId) {
  if (!guildId || !channelId) return;

  lastGuildId = guildId;
  lastChannelId = channelId;
  saveVoiceTarget();

  const existing = getVoiceConnection(guildId);
  if (
    existing &&
    [VoiceConnectionStatus.Ready, VoiceConnectionStatus.Connecting, VoiceConnectionStatus.Signalling].includes(
      existing.state.status,
    )
  ) {
    return;
  }

  try {
    await connectToVoice(guildId, channelId);
  } catch (error) {
    console.error(`[RECONNECT] Reintento fallido, reintentando en ${RECONNECT_DELAY_MS / 1000}s:`, error);
    scheduleReconnect();
  }
}

const joinCommand = {
  data: new SlashCommandBuilder()
    .setName("join")
    .setDescription("Une al bot al VC actual en modo 24/7"),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: 64 });

    const member = await interaction.guild?.members.fetch(interaction.user.id);

    if (!member?.voice.channel) {
      return interaction.editReply({
        content: "Debes estar en un canal de voz para usar este comando.",
      });
    }

    lastGuildId = interaction.guildId!;
    lastChannelId = member.voice.channel.id;
    saveVoiceTarget();

    try {
      await connectToVoice(lastGuildId, lastChannelId);
      await interaction.editReply({
        content: `🎧 Conectado a **${member.voice.channel.name}** en modo 24/7.`,
      });
    } catch (error) {
      console.error("[JOIN] Error al unirse al VC:", error);
      scheduleReconnect();
      await interaction
        .editReply({
          content: "❌ No pude unirme al canal de voz. Reintentaré automáticamente.",
        })
        .catch(() => {});
    }
  },
};

const AUTHORIZED_IDS = [
  "1197314280903680063",
  "1397819397468323961",
];

const leaveCommand = {
  data: new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Desconecta al bot del VC (solo autorizados)"),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!AUTHORIZED_IDS.includes(interaction.user.id)) {
      return interaction.reply({
        content: "No tienes permiso para usar este comando perrita.",
        flags: 64,
      });
    }

    const connection = getVoiceConnection(interaction.guildId!);

    if (connection) {
      audioPlayer.stop();
      connection.destroy();
    }

    if (reconnectTimer) clearTimeout(reconnectTimer);
    lastGuildId = null;
    lastChannelId = null;
    saveVoiceTarget();

    await interaction.reply("👋 Me he desconectado del canal de voz.");
  },
};

const commands = new Collection<
  string,
  typeof joinCommand | typeof leaveCommand
>();
commands.set("join", joinCommand);
commands.set("leave", leaveCommand);

const commandsJSON = [joinCommand.data.toJSON(), leaveCommand.data.toJSON()];

async function deployCommands() {
  const token = process.env.TOKEN;
  const clientId = process.env.BOT_ID;

  if (!token || !clientId) {
    throw new Error("❌ Faltan TOKEN o BOT_ID en el archivo .env");
  }

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(Routes.applicationCommands(clientId), {
    body: commandsJSON,
  });

  console.log(`[DEPLOY] ${commandsJSON.length} comandos registrados en Discord`);
}

bot.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);

  if (!command) {
    console.error(`[ERROR] Comando no encontrado: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`[ERROR] En comando /${interaction.commandName}:`, error);

    const reply = {
      content: "❌ Hubo un error al ejecutar este comando.",
      flags: 64,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

const AUTO_GUILD_ID = process.env.GUILD_ID ?? null;
const AUTO_VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID ?? null;

bot.once(Events.ClientReady, () => {
  console.log("=====================================");
  console.log(`[BOT] ${bot.user?.username} conectado`);
  console.log(`[BOT] ${commands.size} comandos listos`);
  console.log("=====================================");

  bot.user?.setStatus("dnd");

  const guildId = AUTO_GUILD_ID ?? lastGuildId;
  const channelId = AUTO_VOICE_CHANNEL_ID ?? lastChannelId;
  if (guildId && channelId) {
    console.log(`[AUTO] Conectando al canal de voz ${channelId}...`);
    ensureVoiceConnected(guildId, channelId);
  }
});


let starting = false;

async function start() {
  if (starting) return;
  if (bot.isReady()) return;

  starting = true;
  try {
    await deployCommands();

    const token = process.env.TOKEN;
    if (!token) throw new Error("Token no encontrado en .env");

    await bot.login(token);
  } catch (error) {
    console.error("[FATAL] Error al iniciar el bot:", error);
    process.exit(1);
  } finally {
    starting = false;
  }
}

const PORT = Number(process.env.PORT) || 3000;

const miniServer = express();

let server: ReturnType<typeof miniServer.listen> | undefined;

miniServer.get("/bump", (_req: Request, res: Response) => {
  ensureVoiceConnected();
  res.send("BUMPED");
});

miniServer.get("/health", (_req: Request, res: Response) => {
  res.send(bot.isReady() ? "OK" : "STARTING");
});

async function shutdown(signal: string) {
  console.log(`[SHUTDOWN] ${signal} recibido, cerrando...`);
  try {
    audioPlayer.stop();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    bot.destroy();
    server?.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Promesa sin manejar:", reason);
});

server = miniServer.listen(PORT, () => {
  console.log(`[HTTP] Servidor ejecutado en el puerto ${PORT}`);
});

start();