import {Message, Util} from 'discord.js';
import {injectable} from 'inversify';
import Command from '.';
import {TYPES} from '../types.js';
import container from '../inversify.config.js';
import {prisma} from '../utils/db.js';

@injectable()
export default class implements Command {
  public name = 'help';
  public aliases = ['h'];
  public examples = [
    ['help', 'you don\'t need a description'],
  ];

  private commands: Command[] = [];

  public async execute(msg: Message, _: string []): Promise<void> {
    if (this.commands.length === 0) {
      // Lazy load to avoid circular dependencies
      this.commands = container.getAll<Command>(TYPES.Command);
    }

    const settings = await prisma.setting.findUnique({
      where: {
        guildId: msg.guild!.id,
      },
    });

    if (!settings) {
      return;
    }

    const {prefix} = settings;

    const res = Util.splitMessage(this.commands.sort((a, b) => a.name.localeCompare(b.name)).reduce((content, command) => {
      const aliases = command.aliases.reduce((str, alias, i) => {
        str += alias;

        if (i !== command.aliases.length - 1) {
          str += ', ';
        }

        return str;
      }, '');

      if (aliases === '') {
        content += `**${command.name}**:\n`;
      } else {
        content += `**${command.name}** (${aliases}):\n`;
      }

      command.examples.forEach(example => {
        content += `- \`${prefix}${example[0]}\`: ${example[1]}\n`;
      });

      content += '\n';

      return content;
    }, ''));

    for (const r of res) {
      // eslint-disable-next-line no-await-in-loop
      await msg.author.send(r);
    }

    await msg.react('🇩');
    await msg.react('🇲');
  }
}
