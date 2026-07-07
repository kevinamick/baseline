import {
  categoryOgAlt,
  categoryOgContentType,
  categoryOgSize,
  renderCategoryOgImage,
} from "@/app/_components/category-og";

export const alt = categoryOgAlt;
export const size = categoryOgSize;
export const contentType = categoryOgContentType;

export default function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  return renderCategoryOgImage("rubric-based-evaluation", params);
}
