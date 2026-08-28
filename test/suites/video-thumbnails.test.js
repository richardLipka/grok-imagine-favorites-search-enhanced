'use strict';

const { createThumbnailSandbox } = require('../harness');

module.exports = {
  name: 'video thumbnails — video results resolve to parent/child/conversation image',
  run(t) {
    t.group('standard image post');
    let s = createThumbnailSandbox({
      posts: [
        { id: 'img1', mediaType: 'IMAGE', thumbnail: 'https://assets.grok.com/img1_thumb.jpg', mediaUrl: 'https://assets.grok.com/img1.jpg' },
      ],
    });
    t.equal('image post uses its thumbnail', s.getPostThumbnailUrl(s.postById.get('img1')), 'https://assets.grok.com/img1_thumb.jpg');

    t.group('video child post falls back to parent image');
    s = createThumbnailSandbox({
      posts: [
        { id: 'parent1', isChild: false, mediaType: 'IMAGE', thumbnail: 'https://assets.grok.com/p1_thumb.jpg', mediaUrl: 'https://assets.grok.com/p1.jpg' },
        { id: 'vid1', isChild: true, parentId: 'parent1', rootId: 'parent1', mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/vid1.mp4', mediaUrl: 'https://assets.grok.com/vid1.mp4' },
      ],
    });
    t.ok('vid1 is recognized as video post', s.isVideoPost(s.postById.get('vid1')));
    t.equal('video child resolves to parent thumbnail', s.getPostThumbnailUrl(s.postById.get('vid1')), 'https://assets.grok.com/p1_thumb.jpg');

    t.group('grandchild video falls back to root image when immediate parent is also a video');
    s = createThumbnailSandbox({
      posts: [
        { id: 'root1', isChild: false, mediaType: 'IMAGE', thumbnail: 'https://assets.grok.com/root_thumb.jpg', mediaUrl: 'https://assets.grok.com/root.jpg' },
        { id: 'vid_mid', isChild: true, parentId: 'root1', rootId: 'root1', mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/mid.mp4', mediaUrl: 'https://assets.grok.com/mid.mp4' },
        { id: 'vid_leaf', isChild: true, parentId: 'vid_mid', rootId: 'root1', mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/leaf.mp4', mediaUrl: 'https://assets.grok.com/leaf.mp4' },
      ],
    });
    t.equal('grandchild video resolves to root thumbnail', s.getPostThumbnailUrl(s.postById.get('vid_leaf')), 'https://assets.grok.com/root_thumb.jpg');

    t.group('parent video resolves to first child image');
    s = createThumbnailSandbox({
      posts: [
        { id: 'vid_parent', isChild: false, mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/parent.mp4', mediaUrl: 'https://assets.grok.com/parent.mp4' },
        { id: 'child_img', isChild: true, parentId: 'vid_parent', rootId: 'vid_parent', mediaType: 'IMAGE', thumbnail: 'https://assets.grok.com/c_thumb.jpg', mediaUrl: 'https://assets.grok.com/c.jpg' },
      ],
    });
    t.equal('parent video resolves to child image thumbnail', s.getPostThumbnailUrl(s.postById.get('vid_parent')), 'https://assets.grok.com/c_thumb.jpg');

    t.group('video asset resolves to sibling image from same conversation');
    s = createThumbnailSandbox({
      posts: [
        { id: 'asset_img', conversationId: 'conv_123', mediaType: 'IMAGE', thumbnail: 'https://assets.grok.com/asset_thumb.jpg', mediaUrl: 'https://assets.grok.com/asset.jpg' },
        { id: 'asset_vid', conversationId: 'conv_123', mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/asset.mp4', mediaUrl: 'https://assets.grok.com/asset.mp4' },
      ],
    });
    t.equal('video asset resolves to sibling image in same conversation', s.getPostThumbnailUrl(s.postById.get('asset_vid')), 'https://assets.grok.com/asset_thumb.jpg');

    t.group('video post with dedicated image thumbnail uses it');
    s = createThumbnailSandbox({
      posts: [
        { id: 'vid_with_poster', mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/poster.jpg', mediaUrl: 'https://assets.grok.com/vid.mp4' },
      ],
    });
    t.equal('video with jpg poster uses its poster', s.getPostThumbnailUrl(s.postById.get('vid_with_poster')), 'https://assets.grok.com/poster.jpg');

    t.group('standalone video with no image anywhere');
    s = createThumbnailSandbox({
      posts: [
        { id: 'solo_vid', mediaType: 'MEDIA_POST_TYPE_VIDEO', thumbnail: 'https://assets.grok.com/solo.mp4', mediaUrl: 'https://assets.grok.com/solo.mp4' },
      ],
    });
    t.equal('standalone video falls back without throwing', s.getPostThumbnailUrl(s.postById.get('solo_vid')), 'https://assets.grok.com/solo.mp4');
  },
};
