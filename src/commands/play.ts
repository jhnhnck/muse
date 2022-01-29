import {TextChannel, Message} from 'discord.js';
import {URL} from 'url';
import {Except} from 'type-fest';
import shuffle from 'array-shuffle';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import {QueuedSong, STATUS} from '../services/player.js';
import PlayerManager from '../managers/player.js';
import {getMostPopularVoiceChannel, getMemberVoiceChannel} from '../utils/channels.js';
import LoadingMessage from '../utils/loading-message.js';
import errorMsg from '../utils/error-msg.js';
import Command from '.';
import GetSongs from '../services/get-songs.js';
import {prisma} from '../utils/db.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';

@injectable()
export default class implements Command {
  public name = 'play';
  public aliases = ['p'];
  public examples = [
    ['play', 'resume paused playback'],
    ['play https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'plays a YouTube video'],
    ['play cool music', 'plays the first search result for "cool music" from YouTube'],
    ['play https://www.youtube.com/watch?list=PLi9drqWffJ9FWBo7ZVOiaVy0UQQEm4IbP', 'adds the playlist to the queue'],
    ['play https://open.spotify.com/track/3ebXMykcMXOcLeJ9xZ17XH?si=tioqSuyMRBWxhThhAW51Ig', 'plays a song from Spotify'],
    ['play https://open.spotify.com/album/5dv1oLETxdsYOkS2Sic00z?si=bDa7PaloRx6bMIfKdnvYQw', 'adds all songs from album to the queue'],
    ['play https://open.spotify.com/playlist/37i9dQZF1DX94qaYRnkufr?si=r2fOVL_QQjGxFM5MWb84Xw', 'adds all songs from playlist to the queue'],
    ['play cool music immediate', 'adds the first search result for "cool music" to the front of the queue'],
    ['play cool music i', 'adds the first search result for "cool music" to the front of the queue'],
    ['play https://www.youtube.com/watch?list=PLi9drqWffJ9FWBo7ZVOiaVy0UQQEm4IbP shuffle', 'adds the shuffled playlist to the queue'],
    ['play https://www.youtube.com/watch?list=PLi9drqWffJ9FWBo7ZVOiaVy0UQQEm4IbP s', 'adds the shuffled playlist to the queue'],
  ];

  public requiresVC = true;

  private readonly playerManager: PlayerManager;
  private readonly getSongs: GetSongs;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager, @inject(TYPES.Services.GetSongs) getSongs: GetSongs) {
    this.playerManager = playerManager;
    this.getSongs = getSongs;
  }

  // eslint-disable-next-line complexity
  public async execute(msg: Message, args: string[]): Promise<void> {
    const [targetVoiceChannel] = getMemberVoiceChannel(msg.member!) ?? getMostPopularVoiceChannel(msg.guild!);
    const setting = await prisma.setting.findUnique({
      where: {
        guildId: msg.guild!.id,
      }});
    if (!setting) {
      throw new Error(`Couldn't find settings for guild ${msg.guild!.id}`);
    }

    const {playlistLimit} = setting;

    const res = new LoadingMessage(msg.channel as TextChannel);
    await res.start();

    try {
      const player = this.playerManager.get(msg.guild!.id);

      const wasPlayingSong = player.getCurrent() !== null;

      if (args.length === 0) {
        if (player.status === STATUS.PLAYING) {
          await res.stop(errorMsg('already playing, give me a song name'));
          return;
        }

        // Must be resuming play
        if (!wasPlayingSong) {
          await res.stop(errorMsg('nothing to play'));
          return;
        }

        await player.connect(targetVoiceChannel);
        await player.play();

        await Promise.all([
          res.stop('the stop-and-go light is now green'),
          msg.channel.send({embeds: [buildPlayingMessageEmbed(player)]}),
        ]);

        return;
      }

      const addToFrontOfQueue = args[args.length - 1] === 'i' || args[args.length - 1] === 'immediate';
      const shuffleAdditions = args[args.length - 1] === 's' || args[args.length - 1] === 'shuffle';

      let newSongs: Array<Except<QueuedSong, 'addedInChannelId' | 'requestedBy'>> = [];
      let extraMsg = '';

      // Test if it's a complete URL
      try {
        const url = new URL(args[0]);

        const YOUTUBE_HOSTS = [
          'www.youtube.com',
          'youtu.be',
          'youtube.com',
          'music.youtube.com',
          'www.music.youtube.com',
        ];

        if (YOUTUBE_HOSTS.includes(url.host)) {
        // YouTube source
          if (url.searchParams.get('list')) {
          // YouTube playlist
            newSongs.push(...await this.getSongs.youtubePlaylist(url.searchParams.get('list')!));
          } else {
          // Single video
            const song = await this.getSongs.youtubeVideo(url.href);

            if (song) {
              newSongs.push(song);
            } else {
              await res.stop(errorMsg('that doesn\'t exist'));
              return;
            }
          }
        } else if (url.protocol === 'spotify:' || url.host === 'open.spotify.com') {
          const [convertedSongs, nSongsNotFound, totalSongs] = await this.getSongs.spotifySource(args[0], playlistLimit);

          if (totalSongs > playlistLimit) {
            extraMsg = `a random sample of ${playlistLimit} songs was taken`;
          }

          if (totalSongs > playlistLimit && nSongsNotFound !== 0) {
            extraMsg += ' and ';
          }

          if (nSongsNotFound !== 0) {
            if (nSongsNotFound === 1) {
              extraMsg += '1 song was not found';
            } else {
              extraMsg += `${nSongsNotFound.toString()} songs were not found`;
            }
          }

          newSongs.push(...convertedSongs);
        }
      } catch (_: unknown) {
      // Not a URL, must search YouTube
        const query = addToFrontOfQueue ? args.slice(0, args.length - 1).join(' ') : args.join(' ');

        const song = await this.getSongs.youtubeVideoSearch(query);

        if (song) {
          newSongs.push(song);
        } else {
          await res.stop(errorMsg('that doesn\'t exist'));
          return;
        }
      }

      if (newSongs.length === 0) {
        await res.stop(errorMsg('no songs found'));
        return;
      }

      if (shuffleAdditions) {
        newSongs = shuffle(newSongs);
      }

      newSongs.forEach(song => {
        player.add({...song, addedInChannelId: msg.channel.id, requestedBy: msg.author.id}, {immediate: addToFrontOfQueue});
      });

      const firstSong = newSongs[0];

      let statusMsg = '';

      if (player.voiceConnection === null) {
        await player.connect(targetVoiceChannel);

        // Resume / start playback
        await player.play();

        if (wasPlayingSong) {
          statusMsg = 'resuming playback';
        }

        await msg.channel.send({embeds: [buildPlayingMessageEmbed(player)]});
      }

      // Build response message
      if (statusMsg !== '') {
        if (extraMsg === '') {
          extraMsg = statusMsg;
        } else {
          extraMsg = `${statusMsg}, ${extraMsg}`;
        }
      }

      if (extraMsg !== '') {
        extraMsg = ` (${extraMsg})`;
      }

      if (newSongs.length === 1) {
        await res.stop(`u betcha, **${firstSong.title}** added to the${addToFrontOfQueue ? ' front of the' : ''} queue${extraMsg}`);
      } else {
        await res.stop(`u betcha, **${firstSong.title}** and ${newSongs.length - 1} other songs were added to the queue${extraMsg}`);
      }
    } catch (error) {
      await res.stop();
      throw error;
    }
  }
}
