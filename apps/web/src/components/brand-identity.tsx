import Image from 'next/image';
import mark from '@/app/icon.png';

export function BrandMark() {
  return <Image className="brand-mark" src={mark} alt="" width={28} height={28} loading="eager" />;
}

export function BrandIdentity() {
  return (
    <>
      <BrandMark />
      <span>ensemus</span>
    </>
  );
}
