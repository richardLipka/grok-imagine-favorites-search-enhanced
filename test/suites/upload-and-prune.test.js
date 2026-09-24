'use strict';

const { createIndexSandbox } = require('../harness');

module.exports = {
  name: 'upload detection and record pruning (upload-and-prune.test.js)',
  run(t) {
    const m = createIndexSandbox();

    t.group('upload detection');
    t.ok('isUploaded: true flag is recognized',
      m.isUploadedPost({ id: 'u1', isUploaded: true }));

    t.ok('IMAGINE_SELF_UPLOAD_FILE_SOURCE is recognized',
      m.isUploadedPost({ id: 'u2', fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE' }));

    t.ok('generic UPLOAD in fileSource is recognized',
      m.isUploadedPost({ id: 'u3', fileSource: 'USER_UPLOAD' }));

    t.ok('mediaUrl with /upload/ path is recognized',
      m.isUploadedPost({ id: 'u4', mediaUrl: 'https://assets.grok.com/users/123/upload/photo.jpg' }));

    t.ok('thumbnail with /user_upload/ path is recognized',
      m.isUploadedPost({ id: 'u5', thumbnail: 'https://assets.grok.com/user_upload/thumb.webp' }));

    t.ok('standard generated post is not marked uploaded',
      !m.isUploadedPost({ id: 'g1', prompt: 'A futuristic city', mediaUrl: 'https://assets.grok.com/images/city.jpg' }));

    t.group('storage records');
    const uploadedRecord = m.toStorageRecord({ id: 'u1', isUploaded: true, prompt: 'Selfie' });
    t.equal('isUploaded is persisted to storage record', uploadedRecord.isUploaded, true);

    const normalRecord = m.toStorageRecord({ id: 'g1', prompt: 'Landscape' });
    t.equal('normal post has isUploaded false', normalRecord.isUploaded, false);

    t.group('asset parsing');
    const uploadedAsset = m.parseAsset({
      assetId: 'ast1',
      fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE',
      mimeType: 'image/jpeg',
      key: 'users/abc/photo.jpg',
    });
    t.ok('parseAsset detects upload from fileSource', uploadedAsset && uploadedAsset.isUploaded === true);

    const uploadedKeyAsset = m.parseAsset({
      assetId: 'ast2',
      mimeType: 'image/png',
      key: 'users/abc/upload/art.png',
    });
    t.ok('parseAsset detects upload from storage key path', uploadedKeyAsset && uploadedKeyAsset.isUploaded === true);

    const generatedAsset = m.parseAsset({
      assetId: 'ast3',
      mimeType: 'image/jpeg',
      key: 'generations/gen123.jpg',
      mediaGenInput: { prompt: 'A cat' },
    });
    t.ok('parseAsset marks generated asset as not uploaded', generatedAsset && generatedAsset.isUploaded === false);

    t.group('pruning by id');
    m.addPostRow(m.normalizePost({ id: 'del1', prompt: 'Will be deleted' }));
    m.addPostRow(m.normalizePost({ id: 'keep1', prompt: 'Will be kept' }));
    t.ok('posts exist initially', m.postById.has('del1') && m.postById.has('keep1'));

    const writer = m.createIndexWriter();
    const removedCount = m.removeRowsById(['del1'], writer);
    t.equal('removeRowsById returns count of deleted items', removedCount, 1);
    t.ok('deleted post is removed from memory index', !m.postById.has('del1'));
    t.ok('remaining post survives', m.postById.has('keep1'));
    t.ok('deleted id removed from knownIds', !m.knownIds.has('del1'));

    const nonExistentCount = m.removeRowsById(['does-not-exist'], writer);
    t.equal('removeRowsById returns 0 for non-existent id', nonExistentCount, 0);

    t.group('child parsing and metadata diffing');
    const childRaw = {
      id: 'k_up1',
      fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE',
      mediaType: 'MEDIA_POST_TYPE_IMAGE',
    };
    const parentParsed = { id: 'p_root1', prompt: 'Parent prompt' };
    const parsedChild = m.parseChildPost(null, childRaw, parentParsed);
    t.ok('parseChildPost marks child as uploaded', parsedChild && parsedChild.isUploaded === true);

    const postA = m.normalizePost({ id: 'diff1', isUploaded: false });
    const postB = m.normalizePost({ id: 'diff1', isUploaded: true });
    t.ok('postMetadataChanged detects isUploaded change', m.postMetadataChanged(postA, postB) === true);
    t.ok('postMetadataChanged returns false when identical', m.postMetadataChanged(postA, postA) === false);

    t.group('buildPromptById caching');
    const map1 = m.buildPromptById();
    const map2 = m.buildPromptById();
    t.equal('buildPromptById returns cached map across calls without revision change', map1, map2);
  },
};
