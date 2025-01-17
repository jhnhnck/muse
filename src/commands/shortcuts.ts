import {Message} from 'discord.js';
import {injectable} from 'inversify';
import errorMsg from '../utils/error-msg.js';
import Command from '.';
import {prisma} from '../utils/db.js';

@injectable()
export default class implements Command {
  public name = 'shortcuts';
  public aliases = [];
  public examples = [
    ['shortcuts', 'show all shortcuts'],
    ['shortcuts set s skip', 'aliases `s` to `skip`'],
    ['shortcuts set party play https://www.youtube.com/watch?v=zK6oOJ1wz8k', 'aliases `party` to a specific play command'],
    ['shortcuts delete party', 'removes the `party` shortcut'],
  ];

  public async execute(msg: Message, args: string []): Promise<void> {
    if (args.length === 0) {
      // Get shortcuts for guild
      const shortcuts = await prisma.shortcut.findMany({
        where: {
          guildId: msg.guild!.id,
        },
      });

      if (shortcuts.length === 0) {
        await msg.channel.send('no shortcuts exist');
        return;
      }

      // Get prefix for guild
      const settings = await prisma.setting.findUnique({
        where: {
          guildId: msg.guild!.id,
        },
      });

      if (!settings) {
        return;
      }

      const {prefix} = settings;

      const res = shortcuts.reduce((accum, shortcut) => {
        accum += `${prefix}${shortcut.shortcut}: ${shortcut.command}\n`;

        return accum;
      }, '');

      await msg.channel.send(res);
    } else {
      const action = args[0];

      const shortcutName = args[1];

      switch (action) {
        case 'set': {
          const shortcut = await prisma.shortcut.findFirst({
            where: {
              guildId: msg.guild!.id,
              shortcut: shortcutName,
            },
          });

          const command = args.slice(2).join(' ');

          const newShortcut = {shortcut: shortcutName, command, guildId: msg.guild!.id, authorId: msg.author.id};

          if (shortcut) {
            if (shortcut.authorId !== msg.author.id && msg.author.id !== process.env.OWNER_ID) {
              await msg.channel.send(errorMsg('you do\'nt have permission to do that'));
              return;
            }

            await prisma.shortcut.update({
              where: {
                id: shortcut.id,
              },
              data: newShortcut,
            });
            await msg.channel.send('shortcut updated');
          } else {
            await prisma.shortcut.create({data: newShortcut});
            await msg.channel.send('shortcut created');
          }

          break;
        }

        case 'delete': {
          // Check if shortcut exists
          const shortcut = await prisma.shortcut.findFirst({
            where: {
              guildId: msg.guild!.id,
              shortcut: shortcutName,
            },
          });

          if (!shortcut) {
            await msg.channel.send(errorMsg('shortcut doesn\'t exist'));
            return;
          }

          // Check permissions
          if (shortcut.authorId !== msg.author.id && msg.author.id !== process.env.OWNER_ID) {
            await msg.channel.send(errorMsg('you don\'t have permission to do that'));
            return;
          }

          await prisma.shortcut.delete({
            where: {
              id: shortcut.id,
            },
          });

          await msg.channel.send('shortcut deleted');

          break;
        }

        default: {
          await msg.channel.send(errorMsg('unknown command'));
        }
      }
    }
  }
}
